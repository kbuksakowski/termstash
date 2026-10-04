import { discoverSessions } from "../adapters/claude/discover.js";
import type { Discovery } from "../adapters/claude/discover.js";
import { writeArchive } from "../core/archive/store.js";
import { termstashRoot } from "../core/paths.js";
import { assignShortIds, resolveShortId } from "../core/short-id/index.js";
import { allSessions, duplicateSessionMessage, oneSession } from "./sessions.js";
import type { ParsedArgs } from "./args.js";
import { flagBool } from "./args.js";
import { err, out, quoted, relativeTime, safe } from "./format.js";

export type ArchiveDeps = {
  discover?: () => Promise<Discovery>;
  root?: string;
  now?: Date;
};

export async function archiveCommand(args: ParsedArgs, deps: ArchiveDeps = {}): Promise<number> {
  const now = deps.now ?? new Date();
  const root = deps.root ?? termstashRoot();
  const handle = args.positionals[0];

  if (handle === undefined) {
    return fail("termstash archive needs a session id.\n  termstash list\n  termstash archive 7f31a2");
  }

  const discover = deps.discover ?? (() => discoverSessions({ now }));
  // `archive` was the one command still built from the live scan alone, so a
  // session `list` had just shown as ★▪ answered "No session matches" here.
  const { sessions } = await allSessions({ root, discover });
  const resolution = resolveShortId(sessions.map((s) => s.id), handle);

  if (resolution.status === "none") {
    return fail(safe`No session matches ${quoted(handle)}.\nRun 'termstash list' to see what is available.`);
  }
  if (resolution.status === "ambiguous") {
    return fail(
      safe`${quoted(handle)} matches ${resolution.candidates.length} sessions. Use a longer id.`,
    );
  }

  const label = assignShortIds(sessions.map((s) => s.id)).get(resolution.id) ?? resolution.id;
  const picked = oneSession(sessions, resolution.id);
  if (!("session" in picked)) {
    if (picked.duplicates.length === 0) return fail(safe`No session matches ${quoted(handle)}.`);
    return fail(duplicateSessionMessage(label, picked.duplicates));
  }
  const session = picked.session;

  if (session.archivedOnly === true) {
    return fail(
      // "verified" was a claim about bytes made by a command that never
      // hashed them: readArchive checks that the files open, nothing more.
      safe`Claude no longer has a transcript for ${label}, and TermStash already has an archive of it.\n` +
        "There is nothing new to copy.\n" +
        safe`  termstash restore ${label}   puts it back where Claude looks for it\n`,
    );
  }

  if (session.isLive) {
    // Append-only, so a copy is a point-in-time snapshot rather than corrupt,
    // but it will not contain whatever is written after this moment.
    out(
      safe`Note: ${label} is open in another Claude process. The archive is a snapshot of it as of now.\n`,
    );
  }

  const outcome = await writeArchive(
    root,
    {
      sessionId: session.id,
      sourcePath: session.sourcePath,
      sizeBytes: session.sizeBytes,
      mtime: session.updatedAt,
      ...(session.projectPath !== undefined ? { projectPath: session.projectPath } : {}),
      projectDirName: session.projectDirName,
      claudeVersions: session.agentVersions,
    },
    { replace: flagBool(args, "replace"), now },
  );

  switch (outcome.status) {
    case "created":
      out(
        safe`✓ Archived ${label}\n  ${outcome.archive.dir}\n` +
          safe`  verified sha256 ${outcome.archive.manifest.transcriptSha256.slice(0, 16)}…\n` +
          unchecked(outcome.uncheckedLines) +
          (outcome.discarded === undefined
            ? ""
            : safe`  an unreadable archive was already there; its transcript was kept:\n    ${outcome.discarded.quarantinedTo}\n`),
      );
      return 0;

    case "refreshed":
      out(
        safe`✓ Archive refreshed for ${label}\n  ${outcome.archive.dir}\n` +
          safe`  previous snapshot was from ${outcome.previousMtime}\n` +
          unchecked(outcome.uncheckedLines) +
          (outcome.discarded === undefined
            ? ""
            : safe`  ${outcome.discarded.why === "shorter" ? "the live transcript holds less than the archive did" : "the live transcript no longer begins with what the archive held"}, so the old archive was kept:\n    ${outcome.discarded.quarantinedTo}\n`),
      );
      return 0;

    case "already-current":
      // Said "matches the live transcript", which is a claim about bytes made
      // from a size and a timestamp. doctor is the command that compares bytes.
      out(
        safe`Archive already exists and is the same size and timestamp as the live transcript.\nNothing to do.\n  ${outcome.archive.dir}\n` +
          "  'termstash doctor' compares them byte for byte.\n",
      );
      return 0;

    case "stale-refused":
      return fail(
        // "Behind" was printed for an archive that is ahead and for one whose
        // history was rewritten, which are the two cases where acting on the
        // advice below destroys something.
        `Archive already exists and differs from the live transcript ` +
          safe`(archived ${relativeTime(new Date(outcome.archive.manifest.sourceMtime), now)}).\n` +
          "Use an explicit replacement option if you intend to replace it:\n" +
          "  (whatever the archive holds and the live file does not is kept in quarantine)\n" +
          safe`  termstash archive ${label} --replace`,
      );

    case "failed":
      return fail(safe`Archive failed: ${outcome.reason}`);
  }
}

/**
 * The message arrives composed, and composing it is where `safe` belongs: the
 * caller knows which spans are its own layout and which are someone else's
 * text. Sanitising the finished message here would replace this tool's own
 * newlines with U+FFFD and fold a readable refusal into one unreadable line.
 */
/**
 * Records too large to parse.
 *
 * The copy is still byte-exact and checksummed; what could not be done is
 * confirming those records are JSON. Saying so is the difference between a
 * verified archive and one that merely looks like it.
 */
function unchecked(count: number | undefined): string {
  if (count === undefined || count === 0) return "";
  return safe`  ${count} record(s) were too large to parse and were copied unverified\n`;
}

function fail(message: string): number {
  err(`${message}\n`);
  return 1;
}
