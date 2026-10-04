import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { containedPath } from "../core/fs/contain.js";
import { liveSessionIds } from "../adapters/claude/liveness.js";
import { claudeRoot, projectsDir } from "../adapters/claude/paths.js";
import { discoverSessions } from "../adapters/claude/discover.js";
import { scanTranscripts } from "../adapters/claude/scan.js";
import { restoreArchive } from "../core/archive/restore.js";
import { archiveRootError, listArchives, listUnreadableArchives } from "../core/archive/store.js";
import type { StoredArchive } from "../core/archive/store.js";
import { termstashRoot } from "../core/paths.js";
import { allSessions } from "./sessions.js";
import { assignShortIds, resolveShortId } from "../core/short-id/index.js";
import type { ParsedArgs } from "./args.js";
import { flagBool } from "./args.js";
import { err, out, quoted, safe, safeText } from "./format.js";

export type RestoreDeps = {
  root?: string;
  claude?: string;
  now?: Date;
};

export async function restoreCommand(args: ParsedArgs, deps: RestoreDeps = {}): Promise<number> {
  const now = deps.now ?? new Date();
  const root = deps.root ?? termstashRoot();
  const claude = deps.claude ?? claudeRoot();
  const handle = args.positionals[0];

  if (handle === undefined) {
    return fail("termstash restore needs a session id.\n  termstash restore 7f31a2");
  }

  // Resolved against archives, not live sessions: the whole point of restore is
  // that the live transcript may be gone.
  const archives = await listArchives(root);
  if (archives.length === 0) {
    // "There are no archives yet" is a claim, and an unreadable archive root
    // or a refused manifest makes it a false one - about the exact copy this
    // command exists to hand back.
    const blocked = await archiveRootError(root);
    if (blocked !== undefined) {
      return fail(
        safe`TermStash's archive directory could not be read, so nothing can be restored from it:\n  ${blocked}\n` +
          "Fix the permissions and run this again. Your archives are still there.",
      );
    }
    const refused = await listUnreadableArchives(root);
    if (refused.length > 0) {
      return fail(
        safe`${refused.length} archive(s) exist but TermStash refuses them, so none can be restored:\n  ${refused[0] ?? ""}\n` +
          "Run 'termstash doctor --details' to see why. The transcripts inside them are untouched.",
      );
    }
    return fail("There are no archives yet.\n  termstash archive <id>  creates one");
  }

  const resolution = resolveShortId(archives.map((a) => a.sessionId), handle);
  if (resolution.status === "none") {
    return fail(safe`No archive matches ${quoted(handle)}.`);
  }
  if (resolution.status === "ambiguous") {
    return fail(safe`${quoted(handle)} matches ${resolution.candidates.length} archives. Use a longer id.`);
  }

  const archive = archives.find((a) => a.sessionId === resolution.id);
  if (archive === undefined) return fail(safe`No archive matches ${quoted(handle)}.`);
  // Resolved against archives, because only an archive can be restored - but
  // labelled against everything, because the label is printed as a command for
  // `resume` to take. Computed over archives alone it was often shorter than
  // the label `list` uses, so "Resume with: termstash resume abc123" came
  // straight back as "abc123 matches 2 sessions".
  const known = await allSessions({ root, discover: () => discoverSessions({ now }) });
  const label =
    assignShortIds([...new Set([...known.sessions.map((x) => x.id), ...archives.map((a) => a.sessionId)])])
      .get(archive.sessionId) ?? archive.sessionId;

  const resolved = await resolveTargetDir(claude, archive);
  if (!resolved.ok) {
    return fail(
      resolved.reason === "not-recorded"
        ? safe`The archive for ${label} does not record where it belonged, so TermStash cannot place it.`
        : safe`The archive for ${label} records a project directory that resolves outside ` +
          safe`${projectsDir(claude)}. TermStash will not write there. Nothing was changed.`,
    );
  }
  const targetDir = resolved.path;

  const [scan, live] = await Promise.all([scanTranscripts(claude), liveSessionIds(claude)]);
  // "No transcript for this id" is a conclusion drawn from a scan, and the scan
  // can fail. A project directory the scanner could not open read as an empty
  // one, so restore wrote a second copy of a session that was already there -
  // creating the duplicate-session-id state it exists to refuse, with no
  // --replace and no warning.
  if (scan.unreadable.length > 0) {
    return fail(
      safe`${scan.unreadable.length} location(s) under ${projectsDir(claude)} could not be read, so TermStash cannot tell whether ${label} is already there.\n` +
        "Restoring now could leave the same session in two project directories, which Claude cannot resume.\n" +
        "Fix the permissions and run it again. Nothing was changed.\n" +
        safe`  ${scan.unreadable[0]?.path ?? ""}`,
    );
  }
  const existing = scan.transcripts
    .filter((t) => t.id === archive.sessionId)
    .map((t) => ({ path: t.sourcePath }));

  const outcome = await restoreArchive({
    archive,
    existing,
    isLive: live.has(archive.sessionId),
    targetDir,
    containedWithin: projectsDir(claude),
    termstashRoot: root,
    replace: flagBool(args, "replace"),
    now,
  });

  // Both reasons are composed in `restoreArchive` with `safe`, so the paths
  // inside them are already neutralised and the newlines between sentences are
  // the core's own. Line 1 used to keep an attacker's newlines and line 2 used
  // to destroy the tool's: the same mistake in both directions, adjacent.
  if (outcome.status === "refused") return fail(outcome.reason);
  if (outcome.status === "failed") return fail(`Restore failed: ${outcome.reason}`);

  out(safe`✓ Session restored and verified\n  ${safeText(outcome.path)}\n`);
  if (outcome.quarantinedTo !== undefined) {
    out(safe`  the displaced transcript was kept in ${safeText(outcome.quarantinedTo)}\n`);
  }
  out(safe`\n  Resume with:\n    termstash resume ${label}\n`);

  const project = archive.manifest.projectPath;
  if (project !== undefined) {
    out(
      safe`\n  If ${project} no longer exists, resume will ask for an explicit directory:\n` +
        safe`    termstash resume ${label} --cwd <dir>\n`,
    );
  }
  return 0;
}

/**
 * Prefer the bucket the session came from. Restore does not recreate the
 * original repository just because the transcript references it - choosing a
 * working directory is a resume-time decision (PRD v0.2 sections 15 and 21).
 */
/**
 * Where a restore is allowed to land, and why it might not be allowed anywhere.
 *
 * The two branches used to disagree: the `projectDirName` one was checked and
 * the `projectPath` one was not, so the same symlinked bucket was refused or
 * written through depending on which field the manifest happened to carry.
 * Both go through `containedPath` now, and the caller is told which of the two
 * reasons applies — "no location recorded" and "the location is outside
 * Claude's projects directory" are different facts about someone's data.
 */
type TargetDir =
  | { ok: true; path: string }
  | { ok: false; reason: "not-recorded" | "outside" };

async function resolveTargetDir(claude: string, archive: StoredArchive): Promise<TargetDir> {
  const projects = projectsDir(claude);
  // `containedPath` cannot anchor to a root that does not resolve, and a
  // missing projects/ is precisely the disaster-recovery case this command is
  // for: a new machine, or a deleted ~/.claude. The refusal then blamed the
  // manifest - "records a project directory that resolves outside" - for a
  // directory the user simply did not have yet.
  try {
    await mkdir(projects, { recursive: true, mode: 0o700 });
  } catch {
    // If it cannot be created, containedPath refuses below and says so.
  }

  const recorded = archive.manifest.projectDirName;
  if (recorded !== undefined && recorded !== "") {
    const contained = await containedPath(projects, join(projects, recorded));
    return contained === undefined ? { ok: false, reason: "outside" } : { ok: true, path: contained };
  }

  const path = archive.manifest.projectPath;
  if (typeof path === "string" && path !== "") {
    // Every non-alphanumeric becomes a dash, so `..` cannot survive the
    // mangling - but the bucket it names can still be a symlink, which is the
    // half this branch was missing.
    const contained = await containedPath(projects, join(projects, path.replace(/[^a-zA-Z0-9]/g, "-")));
    return contained === undefined ? { ok: false, reason: "outside" } : { ok: true, path: contained };
  }

  return { ok: false, reason: "not-recorded" };
}

/**
 * The message arrives composed, and composing it is where `safe` belongs: the
 * caller knows which spans are its own layout and which are someone else's
 * text. Sanitising the finished message here would replace this tool's own
 * newlines with U+FFFD and fold a readable refusal into one unreadable line.
 */
function fail(message: string): number {
  err(`${message}\n`);
  return 1;
}
