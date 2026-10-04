import { randomBytes } from "node:crypto";
import { describeError } from "../text/safe.js";
import { openRegularFile } from "../fs/regular.js";
import { safe } from "../text/safe.js";
import { chmod, mkdir, open, readFile, rename, rm, unlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { constants } from "node:fs";
import { containedPath } from "../fs/contain.js";
import { DIR_MODE, FILE_MODE } from "../paths.js";
import { isReadableJsonl, sha256File } from "./integrity.js";
import { MANIFEST_NAME } from "./store.js";
import type { StoredArchive } from "./store.js";
import { quarantineTranscript } from "./store.js";

export type ExistingCopy = { path: string };

export type RestoreRequest = {
  archive: StoredArchive;
  /** Every live transcript with this session id, from a full project scan. */
  existing: readonly ExistingCopy[];
  isLive: boolean;
  targetDir: string;
  /**
   * The directory `targetDir` must still resolve inside, re-checked after the
   * mkdir and immediately before the write. Checking against `targetDir`
   * itself is useless: if it was swapped for a symlink, it resolves to itself
   * wherever it now points.
   */
  containedWithin: string;
  termstashRoot: string;
  replace?: boolean;
  now?: Date;
};

export type RestoreOutcome =
  | { status: "restored"; path: string; quarantinedTo?: string }
  | { status: "refused"; reason: string }
  | { status: "failed"; reason: string };

/**
 * PRD v0.2 section 21. The contract is mostly about not writing.
 *
 * Claude resolves a cross-project session id only when exactly one project
 * holds a transcript for it, so a careless restore breaks a session that worked
 * a moment earlier. That was verified experimentally: spike E7/E8.
 */
/** One megabyte, so a 2 GB archive costs a megabyte of memory rather than 2 GB. */
const COPY_CHUNK_BYTES = 1024 * 1024;

export async function restoreArchive(request: RestoreRequest): Promise<RestoreOutcome> {
  const now = request.now ?? new Date();
  const { archive, existing } = request;
  // The directory name, not the manifest field. A readdir entry cannot contain
  // a separator, so it is safe by construction — and it is the value every
  // guard below is computed from. Taking the id from the manifest instead let
  // those guards check one session while the write targeted another.
  const sessionId = archive.sessionId;

  if (request.isLive) {
    return {
      status: "refused",
      reason:
        safe`Session ${sessionId} is currently active in another Claude process.\n` +
        "Refusing to write to a transcript Claude is holding open.",
    };
  }

  if (existing.length >= 2) {
    // Already broken. TermStash cannot know which copy is real, and guessing
    // would destroy the wrong file. No override exists for this.
    return {
      status: "refused",
      reason:
        safe`Cannot restore.\nSession ${sessionId} exists in multiple Claude project directories:\n` +
        existing.map((copy) => safe`  - ${copy.path}`).join("\n") +
        "\nClaude may fail to resume duplicated session IDs.\nNo files were changed.",
    };
  }

  let quarantinedTo: string | undefined;

  if (existing.length === 1) {
    const copy = existing[0];
    if (copy === undefined) return { status: "failed", reason: "internal: missing copy" };

    if (request.replace !== true) {
      return {
        status: "refused",
        reason:
          safe`Cannot restore.\nA transcript for ${sessionId} already exists:\n  ${copy.path}\n` +
          "The live transcript may contain newer work than the archive.\nNo files were changed.\n\n" +
          "To replace it with the archived version:\n" +
          safe`  termstash restore ${sessionId.slice(0, 6)} --replace\n` +
          "The displaced transcript will be kept in the quarantine.",
      };
    }

    try {
      const held = await quarantineTranscript(request.termstashRoot, copy.path, sessionId, now);
      quarantinedTo = held.dir;
      await unlink(copy.path);
    } catch (error) {
      return {
        status: "failed",
        reason: safe`could not set the existing transcript aside: ${describe(error)}. No files were changed.`,
      };
    }
  }

  const target = join(request.targetDir, `${sessionId}.jsonl`);
  const staging = `${target}.termstash-${randomBytes(4).toString("hex")}`;

  try {
    await mkdir(request.targetDir, { recursive: true, mode: DIR_MODE });

    // Re-approved after the directory exists and immediately before the write,
    // because the earlier check happened before a full session scan and
    // everything in between was usable time. containedPath resolves links on
    // both sides, so a bucket swapped for a symlink in the meantime is caught.
    if ((await containedPath(request.containedWithin, target)) === undefined) {
      return {
        status: "failed",
        reason:
          safe`${request.targetDir} now resolves outside ${request.containedWithin}. ` +
          "No files were changed.",
      };
    }

    const handle = await open(
      staging,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      FILE_MODE,
    );
    try {
      // Streamed, not buffered. `readFile` held the whole archive in memory,
      // so a 1 GB archive cost 1.1 GB of RSS and anything past 2 GiB could not
      // be restored at all - the tool manufactured archives it could not give
      // back, with "✓ Archived" and a verified checksum.
      //
      // Opened through the primitive as well: this is a second open by name,
      // after resolveTargetDir, a full scan and a mkdir, and swapping the
      // archive transcript for a FIFO in that window hung restore with the
      // live transcript already quarantined and removed.
      const source = await openRegularFile(archive.transcriptPath);
      if (source === undefined) {
        return { status: "failed", reason: "the archived transcript is not an ordinary file" };
      }
      try {
        // A chunked copy rather than a stream pipeline: the write stream owns
        // the handle, and this one has to stay open for the fsync below. One
        // megabyte at a time keeps memory flat whatever the archive weighs.
        const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
        for (;;) {
          const { bytesRead } = await source.read(buffer, 0, COPY_CHUNK_BYTES, null);
          if (bytesRead === 0) break;
          await handle.write(buffer, 0, bytesRead);
        }
      } finally {
        await source.close();
      }
      await handle.sync();
    } finally {
      await handle.close();
    }

    await chmod(staging, FILE_MODE);
    await rename(staging, target);

    // Section 21 Step 5: the current time, NOT manifest.sourceMtime. Claude's
    // sweep deletes by mtime, so restoring the original one would make the file
    // eligible for deletion at Claude's next launch and silently undo this.
    await utimes(target, now, now);

    const failure = await verify(target, archive);
    if (failure !== undefined) {
      await rm(target, { force: true });
      return {
        status: "failed",
        reason:
          safe`${failure} The restored file was removed.` +
          (quarantinedTo !== undefined
            ? safe`\nThe displaced transcript is still in ${quarantinedTo} and was not deleted.`
            : ""),
      };
    }

    // The archive and the file just written from it are byte-identical, so the
    // manifest should record the mtime it now has. Without this, restore left
    // a pinned session reading as "pinned but NOT protected" the moment it
    // came back - the one state it was least true.
    await recordRestoredMtime(request.archive, now);

    return {
      status: "restored",
      path: target,
      ...(quarantinedTo !== undefined ? { quarantinedTo } : {}),
    };
  } catch (error) {
    await rm(staging, { force: true });
    // Say where the displaced transcript went. The quarantine happens before
    // the write, so a failure here leaves the project directory empty and the
    // user's only copy somewhere they were never told about - the one outcome
    // this tool must never produce in silence.
    return {
      status: "failed",
      reason:
        safe`${describe(error)}` +
        (quarantinedTo !== undefined
          ? safe`\nThe displaced transcript was not deleted. It is in ${quarantinedTo}`
          : ""),
    };
  }
}

/** Section 21 Step 6. */
async function verify(path: string, archive: StoredArchive): Promise<string | undefined> {
  if ((await sha256File(path)) !== archive.manifest.transcriptSha256) {
    return "the restored transcript does not match the archive checksum.";
  }
  if (!(await isReadableJsonl(path))) {
    return "the restored transcript is not readable JSONL.";
  }
  return undefined;
}

function describe(error: unknown): string {
  return describeError(error);
}

/**
 * Point the manifest at the mtime the restored transcript now carries.
 *
 * Best-effort: a restore that worked must not be reported as failed because
 * this bookkeeping did not. The next refresh corrects it either way.
 */
async function recordRestoredMtime(archive: StoredArchive, now: Date): Promise<void> {
  try {
    const path = join(archive.dir, MANIFEST_NAME);
    const handle = await openRegularFile(path);
    if (handle === undefined) return;
    let raw: string;
    try {
      raw = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
    const manifest = JSON.parse(raw) as Record<string, unknown>;
    manifest["sourceMtime"] = now.toISOString();
    // Not `safe`: this is JSON going to disk, and sanitising it replaces the
    // pretty-printer's newlines with U+FFFD, leaving a manifest no reader will
    // parse — so the restored session read as stale for ever after.
    await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
  } catch {
    // Ignored on purpose.
  }
}
