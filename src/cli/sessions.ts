import { basename } from "node:path";
import { stat } from "node:fs/promises";
import { discoverSessions } from "../adapters/claude/discover.js";
import type { Discovery } from "../adapters/claude/discover.js";
import { parseTranscript } from "../adapters/claude/parse.js";
import { archiveRootError, listArchives, listUnreadableArchives } from "../core/archive/store.js";
import type { StoredArchive } from "../core/archive/store.js";
import type { Session } from "../core/session/types.js";
import { safe, safeBlock } from "../core/text/safe.js";

/**
 * Every session this tool can still do something about, live or not.
 *
 * `list`, `search`, `pin`, `unpin` and `resume` each built their world from
 * the live scan alone, which meant a pinned session vanished from all of them
 * the moment Claude swept it — the one moment the pin was for. `list` showed
 * nothing, `pin` and `resume` said "No session matches", and the archive they
 * were all standing on sat two directories away holding a verified copy.
 *
 * A session backed only by an archive is still a session. It carries
 * `archivedOnly`, because what you can do with it is different: restore brings
 * it back, resume cannot reach it until you do.
 */
export type SessionSet = {
  sessions: Session[];
  unreadable: Discovery["unreadable"];
  /** Keyed by session id, for the commands that need the archive itself. */
  archives: Map<string, StoredArchive>;
  /**
   * Why the archive directory could not be listed, if it could not.
   *
   * `listArchives` returns an empty list for "none" and for "could not look",
   * and only `doctor` ever asked which. Every other command read the empty
   * list as proof: `restore` answered "There are no archives yet" over an
   * intact transcript, and `pin` and `resume` answered "No session matches"
   * about a session the user had pinned.
   */
  archivesUnreadable?: string;
  /** Archives that exist and this tool refuses — a broken manifest over good bytes. */
  refusedArchives: string[];
  /**
   * True when some of Claude's storage could not be read.
   *
   * A session backed only by an archive is then not necessarily one Claude
   * swept; it is one whose live transcript we could not see. `list` said
   * "swept by Claude" and `resume` said "Claude no longer has the transcript"
   * about a file that was sitting there intact behind a chmod.
   */
  scanPartial: boolean;
};

export async function allSessions(options: {
  root: string;
  discover: () => Promise<Discovery>;
}): Promise<SessionSet> {
  const [discovery, stored, archivesUnreadable, refusedArchives] = await Promise.all([
    options.discover(),
    listArchives(options.root),
    archiveRootError(options.root),
    listUnreadableArchives(options.root),
  ]);
  const archives = new Map(stored.map((a) => [a.sessionId, a]));
  const scanPartial = discovery.unreadable.length > 0;

  const live = new Set(discovery.sessions.map((s) => s.id));
  const orphaned: Session[] = [];
  for (const archive of stored) {
    if (live.has(archive.sessionId)) continue;
    const session = await archiveSession(archive, scanPartial);
    if (session !== undefined) orphaned.push(session);
  }

  const sessions = [...discovery.sessions, ...orphaned].sort(
    (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime(),
  );
  return {
    sessions,
    unreadable: discovery.unreadable,
    archives,
    ...(archivesUnreadable !== undefined ? { archivesUnreadable } : {}),
    refusedArchives,
    scanPartial,
  };
}

/**
 * Read an archive the way the scanner reads a live transcript.
 *
 * Deliberately the same parser: a restored session has to look like what the
 * user saw before the sweep, or `list` would describe the same conversation
 * two different ways depending on the day.
 */
export async function archiveSession(
  archive: StoredArchive,
  scanPartial: boolean,
): Promise<Session | undefined> {
  // The guard used to cover `stat` only, and `parseTranscript` threw from
  // outside it. One archive deleted between `listArchives` and this loop -
  // which the hook's own refresh does on every turn, renaming the directory
  // aside - took `list`, `search`, `pin`, `unpin`, `resume` and `rename` down
  // with a raw errno and listed nothing at all.
  try {
    const info = await stat(archive.transcriptPath);
    const sizeBytes = info.size;
    // The manifest's `sourceMtime` is the live file's, which is what Claude's
    // sweep went by and what the user last saw in `list`. The archive file's
    // own mtime is an implementation detail of when we copied it.
    let mtime = new Date(archive.manifest.sourceMtime);
    if (Number.isNaN(mtime.getTime())) mtime = info.mtime;
    return await build(archive, sizeBytes, mtime, scanPartial);
  } catch {
    return undefined;
  }
}

async function build(
  archive: StoredArchive,
  sizeBytes: number,
  mtime: Date,
  scanPartial: boolean,
): Promise<Session> {
  const parsed = await parseTranscript(archive.transcriptPath, sizeBytes);
  const cwd = parsed.cwd ?? archive.manifest.projectPath;

  return {
    id: archive.sessionId,
    agent: "claude-code",
    agentVersions: parsed.versions,
    sourcePath: archive.transcriptPath,
    projectDirName: archive.manifest.projectDirName ?? "",
    ...(cwd !== undefined ? { projectPath: cwd, projectName: basename(cwd) } : {}),
    ...(parsed.cwdHistory.length > 0 ? { cwdHistory: parsed.cwdHistory } : {}),
    ...(parsed.gitBranch !== undefined ? { gitBranch: parsed.gitBranch } : {}),
    ...(parsed.title !== undefined ? { title: parsed.title } : {}),
    ...(parsed.titleSource !== undefined ? { titleSource: parsed.titleSource } : {}),
    ...(parsed.createdAt !== undefined ? { createdAt: parsed.createdAt } : {}),
    updatedAt: mtime,
    ...(parsed.lastMessageAt !== undefined ? { lastMessageAt: parsed.lastMessageAt } : {}),
    sizeBytes,
    origin: parsed.origin,
    isLive: false,
    archivedOnly: true,
    hasSubagents: false,
    hasToolResults: false,
    // Claude's sweep has already happened to this one. There is no countdown
    // left to estimate, and "unknown" would suggest there might be - unless
    // the scan was partial, in which case the sweep is an inference and gets
    // stated as one.
    retention: {
      status: "unknown",
      ageDays: 0,
      reason: scanPartial
        ? "no live transcript was found, but some locations could not be read"
        : "swept by Claude; only the archive remains",
    },
    ...(parsed.unknownRecordTypes.length > 0
      ? { unknownRecordTypes: parsed.unknownRecordTypes }
      : {}),
    parseWarnings: parsed.warnings,
  };
}

/**
 * The one session an id names — or the reason there is not one.
 *
 * Two project directories can hold a transcript with the same session id:
 * copy a project, restore a backup, or rename a directory so Claude encodes it
 * under a new name while the old one is still there. Every command that takes
 * an id then resolved it to a list of two and called `.find`, which returns
 * whichever the scan reached first. Measured: with the same id under `alpha`
 * and `beta`, `pin` archived beta's transcript, said "✓ Session aaaaaa
 * pinned", and `list` drew a hollow star on *both* rows — because protection
 * is recorded per id and there were two sessions behind it. `rename` retitled
 * both. The id, which is this tool's whole handle on a session, had stopped
 * identifying one.
 *
 * "Use a longer id" is the wrong answer here and was the one being given: the
 * ids are identical, so no longer id exists.
 */
export function oneSession(
  sessions: readonly Session[],
  id: string,
): { session: Session } | { duplicates: Session[] } {
  const matches = sessions.filter((session) => session.id === id);
  const first = matches[0];
  if (first === undefined || matches.length > 1) return { duplicates: matches };
  return { session: first };
}

/** Said the same way by every command, because the user's next step is the same. */
export function duplicateSessionMessage(label: string, duplicates: readonly Session[]): string {
  const where = duplicates
    .map((session) => `  ${session.projectName ?? session.projectDirName}  ${session.sourcePath}`)
    .join("\n");
  return (
    safe`Session ${label} exists in ${duplicates.length} project directories, and an id cannot tell them apart:\n` +
    `${safeBlock(where)}\n\n` +
    "TermStash will not guess which one you meant. Move or delete the copy you do not want,\n" +
    "and run this again. Nothing was changed."
  );
}
