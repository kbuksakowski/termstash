import { createReadStream } from "node:fs";
import { openUserFile } from "../../core/fs/user-file.js";
import { NotARegularFile, openRegularFile } from "../../core/fs/regular.js";
import { StringDecoder } from "node:string_decoder";

/**
 * Longest single line worth reading. No Claude record comes close; anything
 * larger is corruption or a file that is not a transcript.
 */
export const MAX_LINE_BYTES = 8 * 1024 * 1024;

/**
 * Read a JSONL file line by line, refusing to buffer a line without end.
 *
 * This exists because `readline` does not have that limit. It appends to an
 * internal buffer inside a synchronous `data` handler, so a file whose first
 * line never terminates grows that buffer until V8 refuses the string and
 * throws `RangeError: Invalid string length` — from inside the handler, where
 * no `try` around the loop can catch it. A four-gigabyte sparse file was enough
 * to take down `search` and `doctor` with a stack trace.
 *
 * An over-long line is skipped and counted rather than truncated: half a record
 * is not a record, and a parser handed one would report it as malformed, which
 * would be a different lie.
 */
export async function* readLines(
  path: string,
): AsyncGenerator<{ line: string; skipped: number }> {
  // Opened through the primitive, then streamed from the handle we hold: a
  // FIFO here hung `search` on whichever transcript it reached first.
  const handle = await openUserFile(path);
  if (handle === undefined) throw new NotARegularFile(path);
  const stream = handle.createReadStream();
  const decoder = new StringDecoder("utf8");
  let pending = "";
  // Where the newline search left off. Without it every chunk rescans the whole
  // buffer from zero, which is quadratic inside one over-long line and turns a
  // pathological file into minutes of CPU instead of seconds of I/O.
  let searched = 0;
  let skipping = false;
  let skipped = 0;

  try {
    for await (const chunk of stream) {
      pending += decoder.write(chunk as Buffer);

      for (;;) {
        const at = pending.indexOf("\n", searched);

        if (at === -1) {
          if (pending.length > MAX_LINE_BYTES) {
            // Drop what we hold and keep dropping until a newline shows up.
            if (!skipping) {
              skipping = true;
              skipped += 1;
            }
            pending = "";
          }
          searched = pending.length;
          break;
        }

        const line = pending.slice(0, at);
        pending = pending.slice(at + 1);
        searched = 0;

        if (skipping) {
          skipping = false;
          continue;
        }
        if (line.length > MAX_LINE_BYTES) {
          skipped += 1;
          continue;
        }
        yield { line, skipped };
      }
    }

    pending += decoder.end();
    if (!skipping && pending !== "" && pending.length <= MAX_LINE_BYTES) {
      yield { line: pending, skipped };
    }
  } finally {
    stream.destroy();
  }
}
