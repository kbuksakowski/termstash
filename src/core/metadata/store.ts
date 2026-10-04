import { randomBytes } from "node:crypto";
import { openUserFile, resolveUserFile } from "../fs/user-file.js";
import { openRegularFile } from "../fs/regular.js";
import { lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DIR_MODE, FILE_MODE, metadataFile } from "../paths.js";

/** PRD v0.2 section 26. TermStash's own state, never mixed with Claude's facts. */
export type ArchiveRecord = {
  path: string;
  archivedAt: string;
  sha256: string;
  sourceMtime: string;
  sourceSizeBytes: number;
};

export type ProtectionState = "unprotected" | "protected-current" | "protected-stale";

export type SessionMetadata = {
  sessionId: string;
  pinned?: boolean;
  /**
   * A title the user gave through TermStash.
   *
   * Kept here rather than written into the transcript: PRD v0.2 section 5.3
   * rules out editing Claude-owned files, and a title is exactly the kind of
   * convenience that is not worth making an exception for. The cost is that
   * Claude's own picker will not show it, which `rename` says out loud.
   */
  title?: string;
  /** A cached convenience. The authoritative answer is always recomputed. */
  protectionState?: ProtectionState;
  autoArchive?: boolean;
  archives?: ArchiveRecord[];
  notes?: string;
};

export type MetadataFile = {
  schemaVersion: 1;
  sessions: Record<string, SessionMetadata>;
  /**
   * Malformed entries, held verbatim so a later write puts them back exactly
   * as they were. Reported by doctor; never interpreted, never discarded.
   */
  rejected?: Record<string, unknown>;
};

const EMPTY: MetadataFile = { schemaVersion: 1, sessions: {} };

export async function readMetadata(root: string): Promise<MetadataFile> {
  const path = metadataFile(root);

  // Deliberately outside a try/catch. The first version of this guard threw
  // from *inside* the block whose catch returns an empty file - so the throw
  // that was meant to protect the user's pins was swallowed by the handler it
  // was written to replace, and `rename` still wiped every title. The guard on
  // one side of a boundary and the operation on the other, one more time, in
  // the smallest possible space.
  const handle = await openUserFile(path);
  if (handle === undefined) {
    // "Could not open it" and "it is not there" are different facts, and
    // collapsing them meant an unreadable metadata.json was read as empty and
    // then written back over the real one: every pin and every title gone,
    // under the words "✓ Session pinned". `hook install` guards the same shape
    // for settings.json, and this file is no less the user's.
    const present = await lstat(path)
      .then(() => true)
      .catch(() => false);
    if (present) {
      throw new Error(
        `${path} exists but could not be read. TermStash will not overwrite it; ` +
          "fix the permissions, or move it aside if you want to start over.",
      );
    }
    return { ...EMPTY, sessions: {} };
  }

  let raw: string;
  try {
    raw = await handle.readFile("utf8");
  } finally {
    await handle.close();
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    // Refusing to silently reset someone's pins is more important than
    // convenience: an unreadable file is an error, not an empty one.
    throw new Error(
      `${metadataFile(root)} is not valid JSON. TermStash will not overwrite it; ` +
        "move it aside if you want to start over.",
    );
  }

  // A file of the wrong shape is refused rather than reset, for the same reason
  // invalid JSON is: pins and titles are the user's, and quietly starting over
  // loses them with no way back.
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      `${metadataFile(root)} is not a TermStash metadata file. TermStash will not overwrite it; ` +
        "move it aside if you want to start over.",
    );
  }
  const file = value as Partial<MetadataFile>;
  if (file.sessions === undefined) return { ...EMPTY, sessions: {} };
  if (typeof file.sessions !== "object" || file.sessions === null || Array.isArray(file.sessions)) {
    throw new Error(
      `${metadataFile(root)} has a "sessions" field that is not an object. TermStash will not ` +
        "overwrite it; move it aside if you want to start over.",
    );
  }

  // Per-entry validation, because one bad record used to be enough to take a
  // command down later on: a numeric title reached renderTable as
  // "text is not iterable", and a null entry made every pin in the file
  // disappear from `list` without a word.
  const sessions: Record<string, SessionMetadata> = {};
  const rejected: Record<string, unknown> = {};
  for (const [id, entry] of Object.entries(file.sessions)) {
    if (isSessionMetadata(entry, id)) sessions[id] = entry;
    // Kept verbatim, not reduced to an id. Dropping the entry and then writing
    // the result back meant an ordinary `rename` permanently deleted another
    // session's title and notes - data loss on a routine command, to fix a
    // record the user never touched.
    else rejected[id] = entry;
  }
  return {
    schemaVersion: 1,
    sessions,
    ...(Object.keys(rejected).length > 0 ? { rejected } : {}),
  };
}

function isSessionMetadata(value: unknown, id: string): value is SessionMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const m = value as Record<string, unknown>;
  // The one mandatory field was the one field not checked here: every optional
  // one was validated and `sessionId` was not, so `{"ghost":{"pinned":true}}`
  // reached a caller as a record with no id and took `doctor` down with
  // "Cannot read properties of undefined (reading 'slice')". It also has to
  // agree with the key it is filed under - a record claiming to be a different
  // session is not a record of this one.
  if (typeof m["sessionId"] !== "string" || m["sessionId"] !== id) return false;
  if (m["pinned"] !== undefined && typeof m["pinned"] !== "boolean") return false;
  if (m["title"] !== undefined && typeof m["title"] !== "string") return false;
  if (m["notes"] !== undefined && typeof m["notes"] !== "string") return false;
  if (m["archives"] !== undefined && !Array.isArray(m["archives"])) return false;
  return true;
}

/** Temp file plus rename: a concurrent invocation must never see a truncated file. */
export async function writeMetadata(root: string, file: MetadataFile): Promise<void> {
  // Rejected entries go back under `sessions`, where they came from. They are
  // the user's data; this tool could not read them, which is not the same as
  // being allowed to delete them.
  const merged = {
    schemaVersion: file.schemaVersion,
    sessions: { ...(file.rejected ?? {}), ...file.sessions },
  };
  const path = metadataFile(root);
  await mkdir(dirname(path), { recursive: true, mode: DIR_MODE });

  // Written through a symlink, not over it. A rename replaces the inode, so a
  // metadata.json kept in a dotfiles repository was detached on the first
  // `pin` or `rename` — and the file left behind held only the new entry, so
  // the pins, protection states and archive records in the real file were
  // gone with it.
  // `?? path` meant a dangling link or a symlink loop was renamed *over*,
  // destroying the link. `hook install` refuses exactly this for settings.json
  // ("TermStash will not replace the link"); the two writers disagreed, and
  // this is the one holding the pins.
  const link = await lstat(path).catch(() => undefined);
  const resolved = await resolveUserFile(path);
  if (link?.isSymbolicLink() === true && resolved === undefined) {
    throw new Error(
      `${path} is a symlink whose target does not exist. TermStash will not replace the link; ` +
        "create the file it points at, or remove the link.",
    );
  }
  const target = resolved ?? path;
  const staging = `${target}.termstash-${randomBytes(4).toString("hex")}`;
  try {
    await writeFile(staging, `${JSON.stringify(merged, null, 2)}\n`, { mode: FILE_MODE });
    await rename(staging, target);
  } catch (error) {
    await rm(staging, { force: true });
    throw error;
  }
}

/**
 * Hold a lock around read-modify-write of the whole metadata file.
 *
 * Every caller rewrites the entire file, so two running at once meant the
 * second overwrote the first: ten concurrent pins reported ten successes and
 * recorded eight. A user told a session is protected, with nothing protecting
 * it, is the exact failure this product exists to prevent - worse than an
 * error, because nothing ever says so.
 *
 * An exclusive-create lockfile is enough here: contention is a handful of hook
 * invocations, never a crowd. A stale lock from a killed process is taken over
 * after it ages out rather than deadlocking the next run forever.
 */
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 5_000;

async function withLock<T>(root: string, work: () => Promise<T>): Promise<T> {
  const lock = `${metadataFile(root)}.lock`;
  await mkdir(dirname(lock), { recursive: true, mode: DIR_MODE });

  // Written into the lock and checked before releasing it. Without an owner
  // token the release deleted whatever happened to be at the path, which after
  // a takeover is somebody else's lock.
  const nonce = randomBytes(8).toString("hex");
  const deadline = Date.now() + LOCK_WAIT_MS;

  for (;;) {
    try {
      const handle = await open(lock, "wx", FILE_MODE);
      try {
        await handle.writeFile(nonce);
      } finally {
        await handle.close();
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

      // lstat, not stat: a dangling symlink at the lock path made stat throw
      // ENOENT, and the retry that followed skipped both the deadline and the
      // sleep - a loop that pinned a core for as long as the symlink existed.
      let age: number | undefined;
      try {
        age = Date.now() - (await lstat(lock)).mtimeMs;
      } catch {
        age = undefined; // released, or a link to nothing. Either way, retry.
      }

      if (age !== undefined && age > LOCK_STALE_MS) {
        await rm(lock, { force: true });
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `Another TermStash process is holding ${lock}. ` +
            "If nothing else is running, remove that file.",
        );
      }
      // Every path that does not acquire the lock sleeps and respects the
      // deadline. There is no `continue` above that skips this.
      await new Promise((r) => setTimeout(r, 15 + Math.floor(Math.random() * 35)));
    }
  }

  try {
    return await work();
  } finally {
    // Release only our own lock. If it was taken over while we worked, the file
    // belongs to another process and deleting it would hand a third one a
    // simultaneous hold.
    try {
      // A FIFO at the lock path parked the release inside open(), which meant
      // every pin after the first hung forever.
      const lockHandle = await openRegularFile(lock);
      if (lockHandle !== undefined) {
        let held: string;
        try {
          held = await lockHandle.readFile("utf8");
        } finally {
          await lockHandle.close();
        }
        if (held === nonce) await rm(lock, { force: true });
      }
    } catch {
      // Already gone, or unreadable. Nothing safe left to do.
    }
  }
}

export async function updateSession(
  root: string,
  sessionId: string,
  change: (current: SessionMetadata) => SessionMetadata | undefined,
): Promise<MetadataFile> {
  return withLock(root, async () => {
    const file = await readMetadata(root);
    const current = file.sessions[sessionId] ?? { sessionId };
    const next = change(current);

    // The id is stamped rather than trusted from the callback. This is the one
    // place entries are written, so it is the one place that can guarantee what
    // `readMetadata` requires: an entry carries the id it is filed under.
    if (next === undefined) delete file.sessions[sessionId];
    else file.sessions[sessionId] = { ...next, sessionId };

    await writeMetadata(root, file);
    return file;
  });
}

export function getSession(file: MetadataFile, sessionId: string): SessionMetadata | undefined {
  return file.sessions[sessionId];
}
