import { lstat, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { protectionState } from "../core/archive/protection.js";
import { isSafeSegment } from "../core/archive/manifest.js";
import { readArchive, refreshArchive } from "../core/archive/store.js";
import { readMetadata } from "../core/metadata/store.js";
import { termstashRoot } from "../core/paths.js";
import type { ParsedArgs } from "./args.js";
import { err } from "./format.js";

/**
 * Keep a pinned session's archive current while the session runs.
 *
 * Wired to Claude's `Stop` event, which fires after every assistant turn, and
 * to `SessionEnd`. `Stop` is what makes the guarantee hold: `SessionEnd` does
 * not run when a terminal is killed or Claude crashes, and "I accidentally
 * closed the terminal" is the first problem in PRD v0.2 section 2 - exactly
 * the case a SessionEnd-only hook would miss.
 *
 * The cost is a full verified copy, not a delta. The incremental path this
 * comment used to describe was measured and deleted - it was slower than the
 * copy it avoided.
 *
 * Measured per invocation on an idle machine, for the case that actually
 * happens (the turn that fires this is the turn that appended): 1 MB 0.05 s,
 * 10 MB 0.21 s, 50 MB 0.66 s, 200 MB 2.22 s, medians. The "nothing changed"
 * path is 0.05 s at every size and never opens the transcript.
 *
 * Where it goes, at 200 MB: the copy is the largest single phase at 38%, the
 * three whole-file hashes together about 23%, `checkJsonl` 26%, and the prefix
 * check this does before deciding anything 12%. An earlier version of this
 * comment blamed `checkJsonl` and the final hash for 70% of it; they are 35%.
 *
 * Claude's 60-second timeout is gigabytes away, so the limit is patience, not
 * the hook contract. A size threshold above which this defers to SessionEnd is
 * still the obvious answer and still has not been designed.
 *
 * Rules, because this runs constantly and in someone else's terminal:
 *
 *   - do nothing unless the session is pinned
 *   - never fail the turn or the exit; every failure path returns 0
 *   - stay quiet on success
 */
export async function hookCommand(args: ParsedArgs): Promise<number> {
  const event = args.positionals[0];
  if (event !== "session-end" && event !== "stop") {
    err(
      "usage: termstash hook <stop|session-end>\n" +
        "Reads Claude's hook payload on stdin. Install it with 'termstash hook install'.\n",
    );
    return 1;
  }

  try {
    const payload = await readPayload();
    if (payload === undefined) return 0;

    const root = termstashRoot();
    const metadata = await readMetadata(root);
    if (metadata.sessions[payload.sessionId]?.pinned !== true) return 0;

    // lstat, not stat: a symlink to a FIFO passes a stat() check and then
    // blocks forever on open, which means Claude waits out its hook timeout
    // after every single turn. The archive layer already refuses anything that
    // is not an ordinary file; this is the same rule at the other entrance.
    const link = await lstat(payload.transcriptPath);
    if (!link.isFile()) return 0;
    const info = await stat(payload.transcriptPath);
    if (!info.isFile()) return 0;
    const archive = await readArchive(root, payload.sessionId);
    const state = protectionState({
      pinned: true,
      ...(archive !== undefined ? { manifest: archive.manifest } : {}),
      live: { sizeBytes: info.size, mtime: info.mtime },
    });
    if (state === "protected-current") return 0;

    await refreshArchive(root, {
      sessionId: payload.sessionId,
      sourcePath: payload.transcriptPath,
      sizeBytes: info.size,
      mtime: info.mtime,
      ...(payload.cwd !== undefined ? { projectPath: payload.cwd } : {}),
      ...projectDirNameOf(archive?.manifest.projectDirName, payload.transcriptPath),
      claudeVersions: archive?.manifest.claudeVersions ?? [],
    });
    return 0;
  } catch {
    // Whatever went wrong, the user is trying to quit. Swallow it.
    return 0;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Payload = { sessionId: string; transcriptPath: string; cwd?: string };

/**
 * A hook payload is a few hundred bytes. These are the limits for one.
 *
 * The reader waited for end-of-stream with no deadline and no cap. A producer
 * that holds the write end open stalls the hook until Claude's own 60 s
 * timeout - at the end of every assistant turn - and a producer that keeps
 * writing is buffered in full: 1 GB of stdin reached 1.1 GB of RSS.
 */
const MAX_PAYLOAD_BYTES = 1024 * 1024;
const PAYLOAD_DEADLINE_MS = 5000;

async function readPayload(): Promise<Payload | undefined> {
  const chunks: Buffer[] = [];
  let total = 0;
  const deadline = new Promise<"timeout">((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), PAYLOAD_DEADLINE_MS);
    // Do not hold the process open for the sake of the deadline itself.
    timer.unref();
  });

  const collect = (async () => {
    for await (const chunk of process.stdin) {
      const buffer = chunk as Buffer;
      total += buffer.length;
      if (total > MAX_PAYLOAD_BYTES) return "too-large" as const;
      chunks.push(buffer);
    }
    return "done" as const;
  })();

  const outcome = await Promise.race([collect, deadline]);
  if (outcome !== "done") {
    // Giving up on the read is not enough: an open stdin keeps the event loop
    // alive, so the process sat there anyway and the deadline bought nothing.
    process.stdin.destroy();
    return undefined;
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw === "") return undefined;

  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) return undefined;

  const { session_id: id, transcript_path: path, cwd } = parsed as Record<string, unknown>;
  // The id becomes a directory name under TERMSTASH_HOME, so it is held to the
  // same rule as a manifest's: a real Claude session id is a UUID, and anything
  // else is either corruption or an attempt to pick the path.
  if (typeof id !== "string" || !UUID.test(id)) return undefined;
  if (typeof path !== "string" || path === "") return undefined;

  return { sessionId: id, transcriptPath: path, ...(typeof cwd === "string" ? { cwd } : {}) };
}

/**
 * The project bucket is the transcript's parent directory name.
 *
 * Normalised first. The earlier version split the raw string, so a path whose
 * second-to-last component was `..` produced the bucket name `".."` - which
 * `writeArchive` now refuses outright, and refusing is worse than it sounds
 * here: this runs after every assistant turn, so the pinned session would
 * simply never be archived. `resolve` folds the `..` into the real name, and
 * `isSafeSegment` is the backstop for anything it cannot.
 *
 * Returns `undefined` rather than a guess. `projectDirName` is optional, and
 * an archive without one still restores through `projectPath`; an archive with
 * a wrong one goes somewhere else entirely.
 */
export function bucketOf(transcriptPath: string): string | undefined {
  const name = basename(dirname(resolve(transcriptPath)));
  return isSafeSegment(name) ? name : undefined;
}

/** The recorded bucket if there is one, the transcript's own if it is usable, nothing otherwise. */
function projectDirNameOf(
  recorded: string | undefined,
  transcriptPath: string,
): { projectDirName?: string } {
  if (recorded !== undefined && isSafeSegment(recorded)) return { projectDirName: recorded };
  const bucket = bucketOf(transcriptPath);
  return bucket === undefined ? {} : { projectDirName: bucket };
}
