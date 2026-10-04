import { realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { openRegularFile } from "./regular.js";

/**
 * Open a file the user owns and may legitimately have symlinked.
 *
 * `openRegularFile` refuses to follow a link, which is right for a path this
 * tool chose: a staging file, an archive transcript, somewhere a swapped link
 * would mean an attack. It is wrong for `~/.claude/settings.json`,
 * `metadata.json` and `history.jsonl`, which belong to the user and are very
 * often symlinks into a dotfiles repository.
 *
 * Applying `O_NOFOLLOW` to them broke four things at once, and three of them
 * silently: `hook install` refused to install at all, `readMetadata` returned
 * an empty file so every pin vanished and the Stop hook stopped archiving
 * without a word, the retention period fell back to Claude's default so a
 * warning was given or withheld wrongly, and `search` answered "No matches"
 * because it could not read the prompt history.
 *
 * Resolving the link first and then opening the target under the same rule
 * keeps the protection that matters — a FIFO or a device still cannot park us
 * inside `open()` — while letting an ordinary configuration layout work.
 */
export async function openUserFile(path: string): Promise<FileHandle | undefined> {
  let target = path;
  try {
    target = await realpath(path);
  } catch {
    // Absent, or a link to nowhere. `openRegularFile` gives the same answer
    // for both, and the caller already handles "could not read it".
    return undefined;
  }
  return openRegularFile(target);
}

/**
 * Where a user file actually lives, for a writer that must not replace a link.
 *
 * Returns the path unchanged when it is not a link, and `undefined` when it
 * cannot be resolved — which a writer has to treat as a refusal rather than as
 * permission to create a regular file over the link.
 */
export async function resolveUserFile(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}
