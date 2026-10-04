import { protectionState } from "../core/archive/protection.js";
import { describeError } from "../core/text/safe.js";
import { extendsArchive, readArchive, writeArchive } from "../core/archive/store.js";
import type { ArchiveOutcome } from "../core/archive/store.js";
import { readMetadata, updateSession } from "../core/metadata/store.js";
import { discoverSessions } from "../adapters/claude/discover.js";
import type { Discovery } from "../adapters/claude/discover.js";
import { termstashRoot } from "../core/paths.js";
import type { Session } from "../core/session/types.js";
import { assignShortIds, resolveShortId } from "../core/short-id/index.js";
import { allSessions, duplicateSessionMessage, oneSession } from "./sessions.js";
import type { ParsedArgs } from "./args.js";
import { flagBool } from "./args.js";
import { err, out, quoted, safe, truncate } from "./format.js";

export type PinDeps = {
  discover?: () => Promise<Discovery>;
  root?: string;
  now?: Date;
};

export async function pinCommand(args: ParsedArgs, deps: PinDeps = {}): Promise<number> {
  if (flagBool(args, "at-risk")) return pinAtRisk(args, deps);

  const resolved = await resolve(args, deps, "pin");
  if (typeof resolved === "number") return resolved;
  const { session, label, root, now } = resolved;
  return render(await protect(session, root, now), session, label);
}

/**
 * What protecting one session came to. The work and the wording are separate
 * so that `pin <id>` and `pin --at-risk` cannot drift apart on the one
 * question both must answer the same way: is this session protected now.
 */
type PinResult =
  /** Claude swept the live transcript; the archive is the whole of it. */
  | { kind: "already-archived"; unrecorded?: string }
  /** Refreshing would discard archived work, so the archive was left alone. */
  | { kind: "left-alone"; relation: "shorter" | "no" | "unreadable" }
  | { kind: "failed"; reason: string; unrecorded?: string }
  /** The archive is in place; only the pin could not be recorded. */
  | { kind: "pin-not-saved"; dir: string; reason: string }
  | {
      kind: "pinned";
      status: "created" | "refreshed" | "already-current";
      dir: string;
      unchecked?: number;
    };

async function protect(session: Session, root: string, now: Date): Promise<PinResult> {
  // A session Claude has already swept is reachable here now, and the archive
  // in front of us is the whole of it. Re-archiving would mean copying the
  // archive onto itself; the honest operation is to record the pin and say
  // what the user is actually holding.
  if (session.archivedOnly === true) {
    const stored = await readArchive(root, session.id);
    const unrecorded = await record(
      root,
      session,
      "protected-current",
      stored === undefined
        ? undefined
        : {
            path: stored.dir,
            archivedAt: stored.manifest.archivedAt,
            sha256: stored.manifest.transcriptSha256,
            sourceMtime: stored.manifest.sourceMtime,
            sourceSizeBytes: stored.manifest.transcriptSizeBytes,
          },
    );
    return unrecorded === undefined
      ? { kind: "already-archived" }
      : { kind: "already-archived", unrecorded };
  }

  // Pin means preserved, so the archive is part of the operation, not a
  // follow-up. PRD v0.2 section 17: never claim protection without one.
  // An IO failure used to escape to main() as a raw errno, skipping the branch
  // below - so the session was neither archived nor recorded as pinned, and the
  // user got "EACCES: permission denied, mkdir" instead of being told plainly
  // that the pin is not protecting anything.
  let outcome: ArchiveOutcome;
  try {
    outcome = await writeArchive(root, sourceOf(session), { now });
    if (outcome.status === "stale-refused") {
      // Refreshing a pin is the ordinary thing `pin` is for, and escalating to
      // a replacement was unconditional - so `pin` quietly did what `archive`
      // refuses to do without `--replace`, including when the live transcript
      // had got shorter. The archive then lost the only copy of the work the
      // user pinned it for, under the words "✓ Archive refreshed".
      const relation = await extendsArchive(session.sourcePath, outcome.archive.manifest);
      // Anything but a definite "the live file still contains the archive"
      // refuses. "unreadable" used to fall through to the overwrite.
      if (relation !== "yes") {
        await record(root, session, "protected-stale", undefined);
        return { kind: "left-alone", relation };
      }
      outcome = await writeArchive(root, sourceOf(session), { replace: true, now });
    }
  } catch (error) {
    outcome = {
      status: "failed",
      reason: describeError(error),
    };
  }

  if (outcome.status === "failed") {
    // `markPinned` sat outside the try above, so a metadata write that failed
    // here replaced the whole message below with a raw errno - and the one
    // sentence the user needed, "this session is NOT protected", was the
    // sentence that went missing.
    const unrecorded = await record(root, session, "protected-stale", undefined);
    return unrecorded === undefined
      ? { kind: "failed", reason: outcome.reason }
      : { kind: "failed", reason: outcome.reason, unrecorded };
  }

  // Unreachable today - `replace` skips the branch that returns it - but the
  // old rendering printed "same size and timestamp" for it, which is a claim
  // of protection. If it ever happens it is a failure, not a success.
  if (outcome.status === "stale-refused") {
    const unrecorded = await record(root, session, "protected-stale", undefined);
    const reason = "the archive could not be refreshed";
    return unrecorded === undefined ? { kind: "failed", reason } : { kind: "failed", reason, unrecorded };
  }

  const archive = outcome.archive;
  const unrecorded = await record(root, session, "protected-current", {
    path: archive.dir,
    archivedAt: archive.manifest.archivedAt,
    sha256: archive.manifest.transcriptSha256,
    sourceMtime: archive.manifest.sourceMtime,
    sourceSizeBytes: archive.manifest.transcriptSizeBytes,
  });
  if (unrecorded !== undefined) return { kind: "pin-not-saved", dir: archive.dir, reason: unrecorded };

  // `archive` reports this and `pin` dropped it, about the same file - and
  // `pin` is the command the README presents as the protection path.
  const unchecked =
    outcome.status === "created" || outcome.status === "refreshed"
      ? outcome.uncheckedLines
      : undefined;
  return {
    kind: "pinned",
    status: outcome.status,
    dir: archive.dir,
    ...(unchecked !== undefined ? { unchecked } : {}),
  };
}

/** The full account of one pin, as `pin <id>` has always given it. */
function render(result: PinResult, session: Session, label: string): number {
  switch (result.kind) {
    case "already-archived":
      if (result.unrecorded !== undefined) {
        err(safe`✗ The pin could not be saved: ${result.unrecorded}\n  ${label} is NOT pinned.\n`);
        return 1;
      }
      out(
        safe`✓ Session ${label} pinned\n` +
          "✓ Already archived — Claude has swept the live transcript, so this archive is the only copy\n" +
          "  'termstash doctor' checks it against its recorded checksum\n" +
          safe`  Bring it back with 'termstash restore ${label}'\n`,
      );
      return 0;

    case "left-alone":
      err(
        safe`⚠ Session ${label} is pinned, and its archive was left alone\n` +
          (result.relation === "shorter"
            ? "  The archive holds more than the live transcript, so refreshing it\n  would discard archived work. The archive still has it.\n"
            : "  The live transcript no longer begins with what the archive holds, so\n  refreshing it would discard archived work. The archive still has it.\n") +
          safe`    termstash restore ${label}              brings the archive back\n` +
          safe`    termstash archive ${label} --replace    overwrites it, keeping the old one in quarantine\n`,
      );
      return 1;

    case "failed":
      err(
        safe`⚠ ${label} could not be protected\n` +
          safe`✗ Archive failed: ${result.reason}\n` +
          "  This session is NOT protected from Claude cleanup.\n" +
          (result.unrecorded === undefined
            ? safe`  The pin is recorded, so 'termstash pin ${label}' will try the archive again.\n`
            : safe`  The pin itself could not be saved either: ${result.unrecorded}\n`),
      );
      return 1;

    case "pin-not-saved":
      // The archive exists and is verified; only the pin is missing. Saying
      // "pinned" here would be the false half of a true statement.
      err(
        // The archive may have been created, refreshed, or already been there;
        // this branch asserted the first and "verified" on top of it, in the one
        // place the rest of `pin` deliberately stopped claiming a byte match.
        safe`✓ The archive is in place\n  ${result.dir}\n` +
          safe`✗ The pin could not be saved: ${result.reason}\n` +
          safe`  ${label} is archived but NOT pinned, so the hook will not keep it current.\n`,
      );
      return 1;

    case "pinned":
      out(safe`✓ Session ${label} pinned\n`);
      if (result.unchecked !== undefined && result.unchecked > 0) {
        out(safe`  ${result.unchecked} record(s) were too large to parse and were copied unverified\n`);
      }
      out(
        result.status === "created"
          ? safe`✓ Archive created\n  ${result.dir}\n`
          : result.status === "refreshed"
            ? safe`✓ Archive refreshed\n  ${result.dir}\n`
            : safe`✓ Archive is the same size and timestamp as the live transcript\n  ${result.dir}\n` +
              "  'termstash doctor' compares them byte for byte.\n",
      );
      if (session.isLive) {
        // An archive of a session still being written is a point-in-time snapshot.
        // Saying so now is better than letting the user discover the hollow star later.
        out(
          "\n  This session is open in another Claude process, so the archive is a\n" +
            "  snapshot as of now and will fall behind as you keep working.\n" +
            safe`  Run 'termstash pin ${label}' again to refresh it.\n`,
        );
      }
      return 0;
  }
}

/**
 * Pin every session approaching Claude's retention cutoff, in one command.
 *
 * `doctor` tells a first-time user that dozens of sessions are about to go and
 * none is archived, and the only remedy it could offer was `pin <id>` - once
 * per session, by hand, before anything was lost. That is the habit this
 * product cannot count on people forming in advance, so the remedy is one
 * line instead.
 *
 * Deliberately narrow: only sessions `list --at-risk` would show, the same
 * retention judgement, never a guess. A session whose deadline cannot be
 * determined is not pinned and is counted out loud, as `list` does.
 */
async function pinAtRisk(args: ParsedArgs, deps: PinDeps): Promise<number> {
  if (args.positionals.length > 0) {
    err("termstash pin takes a session id or --at-risk, not both.\n");
    return 1;
  }
  const now = deps.now ?? new Date();
  const root = deps.root ?? termstashRoot();
  const discover = deps.discover ?? (() => discoverSessions({ now }));
  const { sessions, unreadable } = await allSessions({ root, discover });

  const live = sessions.filter((s) => s.archivedOnly !== true);
  // One entry per id. Two transcripts carrying the same id are two rows in
  // `list` but one session to the user, and counting it twice printed the
  // same refusal twice and inflated "N NOT protected".
  const atRisk = [
    ...new Map(live.filter((s) => s.retention.status === "at-risk").map((s) => [s.id, s])).values(),
  ];
  const undeterminable = live.filter((s) => s.retention.status === "unknown").length;
  const labels = assignShortIds(sessions.map((s) => s.id));

  if (unreadable.length > 0) {
    err(
      safe`${unreadable.length} location(s) could not be read, so sessions there were not considered.\n`,
    );
  }
  if (atRisk.length === 0) {
    out("No sessions are approaching Claude's retention cutoff. Nothing to pin.\n");
    if (undeterminable > 0) {
      out(safe`${undeterminable} session(s) could not be judged; 'termstash doctor' says why.\n`);
    }
    return 0;
  }

  // Said before anything is copied: this writes a full copy of every one of
  // these transcripts, and on a machine with large sessions that is a number
  // worth seeing first.
  const bytes = atRisk.reduce((sum, s) => sum + s.sizeBytes, 0);
  out(
    safe`Pinning ${atRisk.length} session${atRisk.length === 1 ? "" : "s"} approaching ` +
      safe`Claude's retention cutoff (${megabytes(bytes)} to copy).\n\n`,
  );

  let protectedCount = 0;
  const notProtected: string[] = [];
  for (const session of atRisk) {
    const label = labels.get(session.id) ?? session.id;
    const title = truncate(session.title ?? session.projectName ?? "", 48);

    // Same rule as `pin <id>`: an id that names two transcripts names neither.
    const picked = oneSession(sessions, session.id);
    if (!("session" in picked)) {
      err(safe`  ✗ ${label}  ${title}\n      exists in more than one project directory; pin it by hand\n`);
      notProtected.push(label);
      continue;
    }

    const result = await protect(session, root, now);
    if (result.kind === "pinned") {
      protectedCount += 1;
      out(safe`  ★ ${label}  ${title}\n`);
    } else {
      notProtected.push(label);
      err(safe`  ✗ ${label}  ${title}\n      ${summary(result)}\n`);
    }
  }

  out(safe`\n${protectedCount} of ${atRisk.length} pinned and archived.\n`);
  if (notProtected.length > 0) {
    err(
      safe`${notProtected.length} NOT protected. 'termstash pin <id>' on one of them gives the full reason.\n`,
    );
  }
  if (undeterminable > 0) {
    out(safe`${undeterminable} more could not be judged and were left alone; 'termstash doctor' says why.\n`);
  }
  out("'termstash hook install' keeps them current as you keep working in them.\n");
  return notProtected.length > 0 ? 1 : 0;
}

/** One line per session in a batch; `pin <id>` prints the full account. */
function summary(result: Exclude<PinResult, { kind: "pinned" }>): string {
  switch (result.kind) {
    case "already-archived":
      return safe`the pin could not be saved: ${result.unrecorded ?? ""}`;
    case "left-alone":
      return "its archive holds work the live transcript does not, so it was left alone";
    case "failed":
      return safe`archive failed: ${result.reason}`;
    case "pin-not-saved":
      return safe`archived, but the pin could not be saved: ${result.reason}`;
  }
}

function megabytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export async function unpinCommand(args: ParsedArgs, deps: PinDeps = {}): Promise<number> {
  const resolved = await resolve(args, deps, "unpin");
  if (typeof resolved === "number") return resolved;
  const { session, label, root } = resolved;

  const metadata = await readMetadata(root);
  if (metadata.sessions[session.id]?.pinned !== true) {
    out(safe`${label} is not pinned. Nothing to do.\n`);
    return 0;
  }

  await updateSession(root, session.id, (current) => ({
    ...current,
    pinned: false,
    protectionState: "unprotected",
  }));

  out(safe`✓ Session ${label} unpinned\n`);

  // Unpinning is a change of intent, not a deletion. Section 35: never silently delete.
  const archive = await readArchive(root, session.id);
  if (archive !== undefined) {
    out(
      safe`  Its archive was kept:\n    ${archive.dir}\n` +
        "  Remove it yourself if you no longer want the copy.\n",
    );
  }
  return 0;
}

type Resolved = { session: Session; label: string; root: string; now: Date };

async function resolve(
  args: ParsedArgs,
  deps: PinDeps,
  verb: string,
): Promise<Resolved | number> {
  const now = deps.now ?? new Date();
  const root = deps.root ?? termstashRoot();
  const handle = args.positionals[0];

  if (handle === undefined) {
    err(safe`termstash ${verb} needs a session id.\n  termstash ${verb} 7f31a2\n`);
    return 1;
  }

  const discover = deps.discover ?? (() => discoverSessions({ now }));
  // Archives included. A swept session used to be unreachable here with its
  // full UUID while `restore` found it instantly, and the message said "No
  // session matches", which was simply untrue.
  const { sessions } = await allSessions({ root, discover });
  const resolution = resolveShortId(sessions.map((s) => s.id), handle);

  if (resolution.status === "none") {
    err(
      safe`No session matches ${quoted(handle)}.\nRun 'termstash list' to see what is available.\n`,
    );
    return 1;
  }
  if (resolution.status === "ambiguous") {
    err(
      safe`${quoted(handle)} matches ${resolution.candidates.length} sessions. Use a longer id.\n`,
    );
    return 1;
  }

  const label = assignShortIds(sessions.map((s) => s.id)).get(resolution.id) ?? resolution.id;
  const picked = oneSession(sessions, resolution.id);
  if (!("session" in picked)) {
    if (picked.duplicates.length === 0) {
      err(safe`No session matches ${quoted(handle)}.\n`);
      return 1;
    }
    // The protection star is drawn per id, so pinning one of two put a star
    // on both rows and archived whichever the scan reached first.
    err(`${duplicateSessionMessage(label, picked.duplicates)}\n`);
    return 1;
  }
  const session = picked.session;

  return {
    session,
    label,
    root,
    now,
  };
}

function sourceOf(session: Session) {
  return {
    sessionId: session.id,
    sourcePath: session.sourcePath,
    sizeBytes: session.sizeBytes,
    mtime: session.updatedAt,
    ...(session.projectPath !== undefined ? { projectPath: session.projectPath } : {}),
    projectDirName: session.projectDirName,
    claudeVersions: session.agentVersions,
  };
}

/** `markPinned`, with the failure returned rather than thrown. Returns the reason, or nothing. */
async function record(
  root: string,
  session: Session,
  state: ReturnType<typeof protectionState>,
  archive: Parameters<typeof markPinned>[3],
): Promise<string | undefined> {
  try {
    await markPinned(root, session, state, archive);
    return undefined;
  } catch (error) {
    return describeError(error);
  }
}

async function markPinned(
  root: string,
  session: Session,
  state: ReturnType<typeof protectionState>,
  archive: {
    path: string;
    archivedAt: string;
    sha256: string;
    sourceMtime: string;
    sourceSizeBytes: number;
  } | undefined,
): Promise<void> {
  await updateSession(root, session.id, (current) => ({
    ...current,
    pinned: true,
    protectionState: state,
    ...(archive !== undefined ? { archives: [archive] } : {}),
  }));
}
