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
import { err, out, quoted, safe } from "./format.js";

export type PinDeps = {
  discover?: () => Promise<Discovery>;
  root?: string;
  now?: Date;
};

export async function pinCommand(args: ParsedArgs, deps: PinDeps = {}): Promise<number> {
  const resolved = await resolve(args, deps, "pin");
  if (typeof resolved === "number") return resolved;
  const { session, label, root, now } = resolved;

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
    if (unrecorded !== undefined) {
      err(safe`✗ The pin could not be saved: ${unrecorded}\n  ${label} is NOT pinned.\n`);
      return 1;
    }
    out(
      safe`✓ Session ${label} pinned\n` +
        "✓ Already archived — Claude has swept the live transcript, so this archive is the only copy\n" +
        "  'termstash doctor' checks it against its recorded checksum\n" +
        safe`  Bring it back with 'termstash restore ${label}'\n`,
    );
    return 0;
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
        err(
          safe`⚠ Session ${label} is pinned, and its archive was left alone\n` +
            (relation === "shorter"
              ? "  The archive holds more than the live transcript, so refreshing it\n  would discard archived work. The archive still has it.\n"
              : "  The live transcript no longer begins with what the archive holds, so\n  refreshing it would discard archived work. The archive still has it.\n") +
            safe`    termstash restore ${label}              brings the archive back\n` +
            safe`    termstash archive ${label} --replace    overwrites it, keeping the old one in quarantine\n`,
        );
        await record(root, session, "protected-stale", undefined);
        return 1;
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
    err(
      safe`⚠ ${label} could not be protected\n` +
        safe`✗ Archive failed: ${outcome.reason}\n` +
        "  This session is NOT protected from Claude cleanup.\n" +
        (unrecorded === undefined
          ? safe`  The pin is recorded, so 'termstash pin ${label}' will try the archive again.\n`
          : safe`  The pin itself could not be saved either: ${unrecorded}\n`),
    );
    return 1;
  }

  const archive = outcome.archive;
  const unrecorded = await record(root, session, "protected-current", {
    path: archive.dir,
    archivedAt: archive.manifest.archivedAt,
    sha256: archive.manifest.transcriptSha256,
    sourceMtime: archive.manifest.sourceMtime,
    sourceSizeBytes: archive.manifest.transcriptSizeBytes,
  });
  if (unrecorded !== undefined) {
    // The archive exists and is verified; only the pin is missing. Saying
    // "pinned" here would be the false half of a true statement.
    err(
      // The archive may have been created, refreshed, or already been there;
      // this branch asserted the first and "verified" on top of it, in the one
      // place the rest of `pin` deliberately stopped claiming a byte match.
      safe`✓ The archive is in place\n  ${archive.dir}\n` +
        safe`✗ The pin could not be saved: ${unrecorded}\n` +
        safe`  ${label} is archived but NOT pinned, so the hook will not keep it current.\n`,
    );
    return 1;
  }

  out(safe`✓ Session ${label} pinned\n`);
  // `archive` reports this and `pin` dropped it, about the same file - and
  // `pin` is the command the README presents as the protection path.
  const unchecked =
    outcome.status === "created" || outcome.status === "refreshed"
      ? outcome.uncheckedLines
      : undefined;
  if (unchecked !== undefined && unchecked > 0) {
    out(safe`  ${unchecked} record(s) were too large to parse and were copied unverified\n`);
  }
  out(
    outcome.status === "created"
      ? safe`✓ Archive created\n  ${archive.dir}\n`
      : outcome.status === "refreshed"
        ? safe`✓ Archive refreshed\n  ${archive.dir}\n`
        : safe`✓ Archive is the same size and timestamp as the live transcript\n  ${archive.dir}\n` +
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
