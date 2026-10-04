import { sha256File } from "../archive/integrity.js";
import { describeError } from "../text/safe.js";
import { isStale, protectionState } from "../archive/protection.js";
import { archiveRootError, extendsArchive, listAbandonedWork, listArchives, listQuarantine, listUnreadableArchives } from "../archive/store.js";
import { readMetadata } from "../metadata/store.js";
import type { Session, TranscriptArtifact } from "../session/types.js";
import type { Finding, DoctorReport } from "./types.js";

/**
 * The newest Claude Code build whose transcripts this project has actually
 * parsed in a test. Bumping it without recording a fixture first would make
 * doctor's silence meaningless (PRD v0.2 section 48.6).
 *
 * Fixtures: test/fixtures/claude-<version>/
 */
export const VERIFIED_CLAUDE_VERSION = "2.1.289";

export type Orphanish = { kind: string; sessionId: string; path: string };

export type HistoryInput = {
  /** Sessions the prompt history remembers but no transcript backs. */
  lost: readonly { id: string; lastSeen: Date; projectPath?: string }[];
  /** History records too old to carry a session id. Counted, never guessed at. */
  unattributed: number;
};

export type DoctorInput = {
  sessions: readonly Session[];
  artifacts: readonly TranscriptArtifact[];
  unreadable: readonly { path: string; reason: string }[];
  orphans: readonly Orphanish[];
  termstashRoot: string;
  /** Claude's projects directory, so restore's staging leftovers are visible too. */
  claudeProjects?: string;
  /** Whether the Stop hook is actually present in Claude's settings. */
  hookInstalled?: boolean;
  history?: HistoryInput;
};

export async function runDoctor(input: DoctorInput): Promise<DoctorReport> {
  const findings: Finding[] = [];
  // Filled by the Archives section below and read by the Protection section,
  // which runs after it.
  const divergedIds = new Set<string>();
  const { sessions } = input;

  /**
   * Whether the scan saw everything there is to see.
   *
   * Two findings below say a session is gone, and both inferred it from
   * absence in a scan that can be partial: one `chmod 000` on `projects/`
   * emptied the scan and turned every intact session into "no longer
   * resumable". Absence is only evidence when the looking was complete, so
   * these say so instead of asserting.
   */
  const partial = input.unreadable.length > 0;
  const couldNotLook =
    `${input.unreadable.length} location(s) could not be read, so this may be wrong — ` +
    "see the Filesystem section";

  // ---- Filesystem: confirmed ----------------------------------------------

  const byId = new Map<string, Session[]>();
  for (const session of sessions) {
    byId.set(session.id, [...(byId.get(session.id) ?? []), session]);
  }
  const duplicates = [...byId.values()].filter((group) => group.length > 1);
  if (duplicates.length > 0) {
    // Claude reports not-found when two projects hold the same id, so this
    // silently breaks resume for every session listed here.
    push(findings, "Filesystem", "confirmed", "duplicate-session-id",
      `${duplicates.length} session id(s) exist in more than one project directory — Claude cannot resume these`,
      duplicates.flatMap((group) => group.map((s) => s.sourcePath)));
  }

  const empty = sessions.filter((s) => s.sizeBytes === 0);
  if (empty.length > 0) {
    push(findings, "Filesystem", "confirmed", "zero-byte-transcript",
      `${empty.length} transcript(s) are empty`, empty.map((s) => s.sourcePath));
  }

  const unparsable = sessions.filter((s) =>
    s.parseWarnings.some((w) => w.includes("unparsable")));
  if (unparsable.length > 0) {
    push(findings, "Filesystem", "confirmed", "unparsable-lines",
      `${unparsable.length} transcript(s) contain lines that are not valid JSON`,
      unparsable.map((s) => `${s.sourcePath} — ${s.parseWarnings.join("; ")}`));
  }

  // A scan that stopped at the line cap saw a prefix, not the file. Calling
  // that "no conversation" is a confirmed claim about something never looked
  // at - and it was wrong about transcripts whose first real record sat just
  // past the cap.
  const scanned = (s: Session) => !s.parseWarnings.some((w) => w.includes("within the first"));
  const degenerate = sessions.filter(
    (s) => s.sizeBytes > 0 && s.createdAt === undefined && s.title === undefined && scanned(s));
  if (degenerate.length > 0) {
    push(findings, "Filesystem", "confirmed", "no-conversation",
      `${degenerate.length} transcript(s) contain no actual conversation`,
      degenerate.map((s) => s.sourcePath));
  }

  if (input.orphans.length > 0) {
    const byKind = new Map<string, Orphanish[]>();
    for (const orphan of input.orphans) {
      byKind.set(orphan.kind, [...(byKind.get(orphan.kind) ?? []), orphan]);
    }
    for (const [kind, group] of byKind) {
      // "whose session is gone" is inferred from the same scan the two findings
      // below already qualify. One unreadable project directory made doctor
      // state, as confirmed, that a live session's checkpoints were orphans -
      // and a user acting on that deletes the checkpoints of a session that
      // still exists.
      push(findings, "Filesystem", partial ? "potential" : "confirmed", `orphaned-${kind}`,
        partial
          ? `${group.length} ${kind} director(ies) have no session TermStash could find`
          : `${group.length} orphaned ${kind} director(ies) whose session is gone`,
        [...group.map((o) => o.path), ...(partial ? [couldNotLook] : [])]);
    }
  }

  for (const entry of input.unreadable) {
    push(findings, "Filesystem", "confirmed", "unreadable-path",
      `could not read ${entry.path}`, [entry.reason]);
  }

  // ---- Filesystem: potential ----------------------------------------------

  const liveIds = new Set(sessions.map((s) => s.id));
  const strays = input.artifacts.filter((a) => !liveIds.has(a.sessionId));
  if (strays.length > 0) {
    // Behaviour of these files under `claude --resume` is unverified, so
    // TermStash reports them and does nothing else (section 6.8).
    push(findings, "Filesystem", "potential", "recoverable-artifact",
      `${strays.length} potential recoverable transcript artifact(s) found`,
      strays.map((a) => a.path));
  }

  const noCwd = sessions.filter((s) => s.projectPath === undefined);
  if (noCwd.length > 0) {
    push(findings, "Sessions", "potential", "no-project-path",
      `${noCwd.length} session(s) never recorded a working directory`,
      noCwd.map((s) => s.sourcePath));
  }

  const unknownTypes = new Set<string>();
  for (const session of sessions) {
    for (const type of session.unknownRecordTypes ?? []) unknownTypes.add(type);
  }
  if (unknownTypes.size > 0) {
    push(findings, "Sessions", "potential", "unknown-record-types",
      `${unknownTypes.size} unrecognised record type(s) — Claude's transcript format may have moved`,
      [...unknownTypes].sort());
  }

  const newerVersions = [...new Set(sessions.flatMap((s) => s.agentVersions))]
    .filter((v) => compareVersions(v, VERIFIED_CLAUDE_VERSION) > 0)
    .sort(compareVersions);
  if (newerVersions.length > 0) {
    // Claude auto-updates, so this is expected rather than alarming. It is
    // reported once, about the versions, not once per session: the useful fact
    // is that parsing is untested against them, not how many files exist.
    const range =
      newerVersions.length === 1
        ? newerVersions[0]
        : `${newerVersions[0]}–${newerVersions[newerVersions.length - 1]}`;
    push(findings, "Sessions", "potential", "newer-claude-version",
      `transcripts written by Claude Code ${range}, newer than the verified ${VERIFIED_CLAUDE_VERSION} — parsing is untested against ${newerVersions.length === 1 ? "it" : "these"}`,
      newerVersions);
  }

  // ---- Retention: informational -------------------------------------------

  const atRisk = sessions.filter((s) => s.retention.status === "at-risk");
  if (atRisk.length > 0) {
    push(findings, "Retention", "informational", "approaching-cutoff",
      `${atRisk.length} session(s) are approaching Claude's retention cutoff`,
      atRisk.map((s) => `${s.id.slice(0, 6)}  ${s.projectName ?? "—"}  ${s.retention.ageDays}d old`));
  }

  const unknownRetention = sessions.filter((s) => s.retention.status === "unknown");
  if (unknownRetention.length > 0) {
    push(findings, "Retention", "informational", "retention-unknown",
      `${unknownRetention.length} session(s) have an undeterminable retention status`,
      unknownRetention.map((s) => `${s.id.slice(0, 6)}  ${s.retention.reason ?? ""}`));
  }

  const goneProjects = sessions.filter((s) => s.projectPathExists === false);
  if (goneProjects.length > 0) {
    push(findings, "Sessions", "informational", "project-path-missing",
      `${goneProjects.length} session(s) reference a project directory that no longer exists`,
      goneProjects.map((s) => `${s.id.slice(0, 6)}  ${s.projectPath ?? ""}`));
  }

  // ---- Archives and protection --------------------------------------------

  const archives = await listArchives(input.termstashRoot);

  // Two transcripts carrying one session id, in two project directories.
  // Reported before anything is computed from `sessionsById`, because that map
  // keeps whichever came last and every archive-versus-live comparison below
  // is then about one of the two chosen at random. `pin`, `archive`, `rename`
  // and `resume` now refuse rather than pick; this is the only command that
  // can say the state exists at all, and nothing used to.
  const liveById = new Map<string, Session[]>();
  for (const session of sessions) {
    if (session.archivedOnly === true) continue;
    liveById.set(session.id, [...(liveById.get(session.id) ?? []), session]);
  }
  const duplicated = [...liveById.values()].filter((group) => group.length > 1);
  if (duplicated.length > 0) {
    push(findings, "Sessions", "confirmed", "duplicate-session-id",
      `${duplicated.length} session id(s) exist in more than one project directory — commands that take an id refuse them`,
      duplicated.flatMap((group) => [
        `${group[0]?.id ?? ""}`,
        ...group.map((session) => `    ${session.sourcePath}`),
      ]));
  }

  const sessionsById = new Map(sessions.map((s) => [s.id, s]));

  // An archive whose manifest will not parse is invisible to every other
  // command, which is the one way this tool must never fail: the user believes
  // a session is protected and nothing will ever restore it. Reported as
  // confirmed, because the filesystem says so.
  const archiveRootProblem = await archiveRootError(input.termstashRoot);
  if (archiveRootProblem !== undefined) {
    push(findings, "Archives", "confirmed", "archive-root-unreadable",
      "TermStash's archive directory could not be read, so no archive is visible to any command — including restore",
      [archiveRootProblem]);
  }

  const unreadableArchives = await listUnreadableArchives(input.termstashRoot);
  // The directory name is the session id, so a refused archive still says
  // which session it belongs to.
  const rejectedArchiveIds = new Set(
    unreadableArchives.map((dir) => dir.slice(dir.lastIndexOf("/") + 1)),
  );
  if (unreadableArchives.length > 0) {
    push(findings, "Archives", "confirmed", "archive-manifest-unreadable",
      `${unreadableArchives.length} archive(s) are unusable — an unreadable manifest, or a transcript that is not an ordinary file. They will not restore`,
      unreadableArchives);
  }

  const mismatched: string[] = [];
  for (const archive of archives) {
    try {
      if ((await sha256File(archive.transcriptPath)) !== archive.manifest.transcriptSha256) {
        mismatched.push(archive.dir);
      }
    } catch (error) {
      mismatched.push(`${archive.dir} — ${describe(error)}`);
    }
  }
  if (mismatched.length > 0) {
    push(findings, "Archives", "confirmed", "archive-checksum-mismatch",
      `${mismatched.length} archive(s) do not match their recorded checksum`, mismatched);
  }

  const abandoned = await listAbandonedWork(input.termstashRoot, input.claudeProjects);
  // `.previous-` directories are not all leftovers. `writeArchive` keeps one
  // deliberately whenever the replacement did not contain the old archive, so
  // calling every one of them "left by an interrupted run — safe to delete"
  // pointed the user at the only copy of a transcript, and sometimes at files
  // they had put there themselves.
  const kept = abandoned.filter((path) => path.includes("/.previous-"));
  const leftover = abandoned.filter((path) => !path.includes("/.previous-"));
  if (leftover.length > 0) {
    // "Safe to delete" was true and useless: nothing deleted them, including a
    // later successful archive of the same session, so they accumulated at the
    // rate the user closed a terminal mid-turn. The next archive now removes
    // any that have been untouched for an hour, and this says so rather than
    // leaving the user to do it by hand.
    push(findings, "Archives", "informational", "abandoned-work-directory",
      `${leftover.length} working file(s) and director(ies) left by an interrupted run — the next archive removes any untouched for an hour`,
      leftover);
  }
  if (kept.length > 0) {
    push(findings, "Archives", "informational", "superseded-archive-kept",
      `${kept.length} previous archive(s) were kept because the replacement did not contain them — check before deleting`,
      kept);
  }

  const orphanedArchives = archives.filter((a) => !sessionsById.has(a.sessionId));
  if (orphanedArchives.length > 0) {
    // Not a problem: this is the archive doing its job after a sweep.
    push(findings, "Archives", "informational", "archive-without-live-session",
      partial
        ? `${orphanedArchives.length} archive(s) have no live Claude transcript that TermStash could see`
        : `${orphanedArchives.length} archive(s) have no live Claude transcript — restore brings them back`,
      [
        ...orphanedArchives.map((a) => `${a.sessionId.slice(0, 6)}  ${a.dir}`),
        ...(partial ? [couldNotLook] : []),
      ]);
  }

  let metadataError: string | undefined;
  let pinnedIds = new Set<string>();
  let rejectedEntries: string[] = [];
  try {
    const metadata = await readMetadata(input.termstashRoot);
    pinnedIds = new Set(
      Object.values(metadata.sessions).filter((e) => e.pinned === true).map((e) => e.sessionId));
    rejectedEntries = Object.keys(metadata.rejected ?? {});
  } catch (error) {
    metadataError = describe(error);
  }
  if (metadataError !== undefined) {
    push(findings, "Protection", "confirmed", "metadata-unreadable",
      "TermStash's own metadata could not be read", [metadataError]);
  }
  if (rejectedEntries.length > 0) {
    // Dropping a malformed entry is right; dropping it in silence is not. A pin
    // that no longer counts is exactly the state the user must be told about.
    push(findings, "Protection", "confirmed", "metadata-entry-rejected",
      `${rejectedEntries.length} metadata entr(ies) are malformed and were ignored — any pin or title on them is not in effect`,
      rejectedEntries);
  }

  // A live transcript that no longer begins with what the archive holds -
  // `/compact` is the ordinary cause. The archive is the only copy of the
  // conversation before the rewrite, and nothing else in this report says so:
  // `list` shows ☆ and the Protection section called it "behind", which is the
  // opposite of what happened.
  const divergedPrefix: string[] = [];
  for (const archive of archives) {
    const session = sessionsById.get(archive.sessionId);
    if (session === undefined) continue;
    if (session.sizeBytes < archive.manifest.transcriptSizeBytes) continue;
    if ((await extendsArchive(session.sourcePath, archive.manifest)) === "no") {
      divergedPrefix.push(`${archive.sessionId.slice(0, 6)}  ${session.sourcePath}`);
      divergedIds.add(archive.sessionId);
    }
  }
  if (divergedPrefix.length > 0) {
    push(findings, "Archives", "confirmed", "archive-history-rewritten",
      `${divergedPrefix.length} live transcript(s) no longer begin with what their archive holds — the session was compacted or rewritten, so the archive is the only copy of what came before. TermStash will not overwrite it automatically`,
      divergedPrefix);
  }

  // Nothing in this report ever looked at settings.json, so a hook that was
  // never installed - or that another tool's write removed after ours, which
  // no in-process check can prevent - was invisible. The only symptom was the
  // star going hollow some turns later, which looks like ordinary staleness.
  if (pinnedIds.size > 0 && input.hookInstalled === false) {
    push(findings, "Protection", "informational", "hook-not-installed",
      `${pinnedIds.size} pinned session(s), and the Stop hook is not in Claude's settings — their archives are refreshed only when you run 'termstash pin' or 'termstash archive' yourself`,
      ["termstash hook install"]);
  }

  const archivesById = new Map(archives.map((a) => [a.sessionId, a]));
  const stale: string[] = [];
  for (const id of pinnedIds) {
    const session = sessionsById.get(id);
    const archive = archivesById.get(id);
    const state = protectionState({
      pinned: true,
      ...(archive !== undefined ? { manifest: archive.manifest } : {}),
      ...(session !== undefined
        ? { live: { sizeBytes: session.sizeBytes, mtime: session.updatedAt } }
        : {}),
    });
    if (state === "protected-stale") {
      stale.push(
        `${id.slice(0, 6)}  ${describeMissingProtection(
          archive,
          rejectedArchiveIds.has(id),
          session === undefined ? undefined : { sizeBytes: session.sizeBytes },
          divergedIds.has(id),
        )}`);
    }
  }
  if (stale.length > 0) {
    push(findings, "Protection", "confirmed", "pinned-not-protected",
      `${stale.length} pinned session(s) are NOT currently protected`, stale);
  }

  // Staleness is decided on size and mtime everywhere else, because computing a
  // checksum on every `list` would be absurd. That makes one state invisible:
  // same length, same mtime, different bytes - which `rsync -a` or `tar -p`
  // from a backup produces without anyone meaning to. doctor is where the
  // expensive answer belongs, so it is the one command that compares the
  // archive with the session it claims to be a copy of.
  //
  // It said so and did something else. The loop reported every checksum
  // difference, which is mostly the ordinary case of an archive that fell
  // behind - already visible as a hollow star and already reported above - and
  // announced it as the invisible one. Found on a real machine: two archives
  // differing in size, mtime and bytes, reported as "not marked stale".
  const invisible: string[] = [];
  const behind: string[] = [];
  const timestampOnly: string[] = [];
  for (const archive of archives) {
    const session = sessionsById.get(archive.sessionId);
    if (session === undefined) continue; // reported by archive-without-live-session
    let live: string;
    try {
      live = await sha256File(session.sourcePath);
    } catch {
      continue; // unreadable live transcripts have their own check
    }
    const outdated = isStale(archive.manifest, {
      sizeBytes: session.sizeBytes,
      mtime: session.updatedAt,
    });
    const sameBytes = live === archive.manifest.transcriptSha256;
    const line = `${archive.sessionId.slice(0, 6)}  ${session.sourcePath}`;

    if (!outdated && !sameBytes) invisible.push(line);
    // Excluded: pinned sessions (reported as a protection failure), archives
    // whose history was rewritten, and archives that hold more than the live
    // file. All three used to land here under advice to run `--replace`, which
    // is the command that discards whatever the archive has and the live file
    // does not.
    else if (
      outdated &&
      !sameBytes &&
      !pinnedIds.has(archive.sessionId) &&
      !divergedIds.has(archive.sessionId) &&
      session.sizeBytes >= archive.manifest.transcriptSizeBytes
    ) {
      behind.push(line);
    }
    else if (outdated && sameBytes) timestampOnly.push(line);
  }

  // An archive longer than its live session holds conversation the live file no
  // longer does - compaction, a crash, a restored backup. The hook refuses to
  // overwrite it; the user still has to be told it is there.
  const longerThanLive: string[] = [];
  for (const archive of archives) {
    const session = sessionsById.get(archive.sessionId);
    if (session === undefined) continue;
    if (session.sizeBytes < archive.manifest.transcriptSizeBytes) {
      longerThanLive.push(
        `${archive.sessionId.slice(0, 6)}  archive ${archive.manifest.transcriptSizeBytes} bytes, live ${session.sizeBytes}`,
      );
    }
  }
  if (longerThanLive.length > 0) {
    push(findings, "Archives", "confirmed", "archive-longer-than-live",
      `${longerThanLive.length} archive(s) hold more than their live transcript — the live file was shortened, and TermStash will not overwrite the archive automatically. 'termstash restore <id>' brings the longer version back`,
      longerThanLive);
  }

  if (invisible.length > 0) {
    push(findings, "Archives", "confirmed", "archive-diverged-from-live",
      `${invisible.length} archive(s) have the same size and timestamp as their live session but different bytes — no other command can see this. Refresh with 'termstash archive <id> --replace'`,
      invisible);
  }
  if (behind.length > 0) {
    // Pinned sessions are left out: pinned-not-protected above already says it,
    // and saying it twice makes one problem look like two.
    push(findings, "Archives", "informational", "archive-behind-live",
      `${behind.length} archive(s) are behind their live session — refresh with 'termstash archive <id> --replace'`,
      behind);
  }
  if (timestampOnly.length > 0) {
    push(findings, "Archives", "informational", "archive-timestamp-only",
      `${timestampOnly.length} archive(s) count as stale only because the transcript's timestamp moved — the bytes still match, so a refresh would change nothing`,
      timestampOnly);
  }

  if (input.history !== undefined && input.history.lost.length > 0) {
    const lost = input.history.lost;
    const newest = lost.reduce((a, b) => (a.lastSeen > b.lastSeen ? a : b));
    const oldest = lost.reduce((a, b) => (a.lastSeen < b.lastSeen ? a : b));
    // "At least": records predating Claude's sessionId field cannot be
    // attributed, so this is a floor and must never be stated as a total
    // (PRD v0.2 section 14).
    push(findings, "Sessions", "informational", "historical-sessions",
      partial
        ? `at least ${lost.length} session(s) existed and TermStash found no transcript for them`
        : `at least ${lost.length} session(s) existed and are no longer resumable — ` +
          "their prompts survive in Claude's history, their transcripts do not",
      [
        `most recent: ${newest.lastSeen.toISOString().slice(0, 10)}  ${newest.projectPath ?? ""}`,
        `oldest:      ${oldest.lastSeen.toISOString().slice(0, 10)}  ${oldest.projectPath ?? ""}`,
        ...(input.history.unattributed > 0
          ? [`${input.history.unattributed} older history record(s) carry no session id and were not counted`]
          : []),
        ...(partial ? [couldNotLook] : ["termstash search <query> looks through these too"]),
      ]);
  }

  const quarantined = await listQuarantine(input.termstashRoot);
  if (quarantined.length > 0) {
    push(findings, "Archives", "informational", "quarantined-transcripts",
      `${quarantined.length} transcript(s) held in quarantine — displaced by a restore, or set aside before an archive was overwritten`,
      quarantined.map((q) => q.dir));
  }

  return {
    sessionCount: sessions.length,
    archiveCount: archives.length,
    scanPartial: partial,
    findings,
  };
}

/**
 * Why a pin is not protecting anything.
 *
 * "no archive" was printed whenever `readArchive` returned nothing, which also
 * covers an archive that exists and was refused - a broken manifest over an
 * intact transcript. A user told the copy never existed stops looking for it.
 */
function describeMissingProtection(
  archive: { manifest: { transcriptSizeBytes: number } } | undefined,
  rejected: boolean,
  live: { sizeBytes: number } | undefined,
  diverged: boolean,
): string {
  if (archive === undefined) {
    return rejected
      ? "an archive exists but TermStash refuses it — see the Archives section"
      : "no archive";
  }
  if (diverged) return "the transcript was rewritten; the archive holds what came before";
  if (live === undefined) return "no live transcript to compare against";
  if (live.sizeBytes < archive.manifest.transcriptSizeBytes) {
    return "the archive holds more than the live transcript";
  }
  return "archive is behind the transcript";
}

function push(
  findings: Finding[],
  section: Finding["section"],
  cls: Finding["class"],
  code: string,
  summary: string,
  details: string[],
): void {
  findings.push({ section, class: cls, code, summary, details });
}

/** Numeric dotted comparison. Anything unparseable sorts as equal, never newer. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10));
  const pb = b.split(".").map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function describe(error: unknown): string {
  return describeError(error);
}
