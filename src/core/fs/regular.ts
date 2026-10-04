import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";

/**
 * The only way anything below the CLI layer opens a file for reading.
 *
 * Three separate hangs came from opening by name and asking questions
 * afterwards, and one of them stopped `hook stop` — which runs after every
 * assistant turn — until the process was killed with SIGKILL. The lesson is
 * narrow and worth stating: `O_NOFOLLOW` answers *is this a symlink*, not
 * *will open() return*. Opening a FIFO or a character device blocks inside the
 * syscall, so an `isFile()` check placed after it never executes, and the
 * process cannot even exit: `process.exit()` does not return while a libuv
 * thread is parked in `open()`.
 *
 * `O_NONBLOCK` is what makes the question answerable. On a regular file it has
 * no effect on reads; on a FIFO it makes `open` return immediately so `fstat`
 * can be asked about the handle actually held — not about a name that may have
 * described something else a moment ago.
 *
 * Returns `undefined` rather than throwing, because every caller's honest
 * answer to "this is not an ordinary file" is to refuse and say so, not to
 * unwind.
 */
export async function openRegularFile(path: string): Promise<FileHandle | undefined> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return undefined;
  }

  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      await handle.close();
      return undefined;
    }
    return handle;
  } catch {
    await handle.close();
    return undefined;
  }
}

/**
 * Create a file that must not already exist, following no link.
 *
 * `O_EXCL` is the write-side half of the same rule: a staging path that turns
 * out to be a symlink is a refusal, not a write through it.
 */
export async function createExclusiveFile(
  path: string,
  mode: number,
): Promise<FileHandle | undefined> {
  try {
    return await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      mode,
    );
  } catch {
    return undefined;
  }
}

/** Thrown where a caller cannot express refusal in its return type. */
export class NotARegularFile extends Error {
  constructor(path: string) {
    // It may be a FIFO, a device, a symlink we refused to follow, or a file we
    // simply cannot open. `openRegularFile` returns one answer for all of
    // them, so this message must not pick one and assert it.
    super(`${path} could not be read as an ordinary file`);
    this.name = "NotARegularFile";
  }
}
