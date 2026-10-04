import { createHash } from "node:crypto";
import { NotARegularFile, openRegularFile } from "../fs/regular.js";

/**
 * `limit` hashes a prefix rather than the whole file.
 *
 * A transcript Claude is still writing to grows between the copy and the
 * check, so hashing "the file" twice hashes two different files. The caller
 * passes the byte count it already took with `stat`.
 */
export async function sha256File(path: string, limit?: number): Promise<string> {
  const handle = await openRegularFile(path);
  if (handle === undefined) throw new NotARegularFile(path);
  try {
    const hash = createHash("sha256");
    // `end` is inclusive, so `limit - 1` is right for every limit but zero -
    // where it becomes `end: -1` and throws from inside the stream. The guard
    // that calls this then read the crash as "unreadable", and the one caller
    // that only tested for "no" read *that* as permission to overwrite. A
    // three-valued answer whose third value is treated as yes is the same
    // shape as the defect it replaced.
    const stream =
      limit === undefined
        ? handle.createReadStream()
        : limit === 0
          ? undefined
          : handle.createReadStream({ end: limit - 1 });
    if (stream !== undefined) {
      for await (const chunk of stream) hash.update(chunk as Buffer);
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

/**
 * Confirm a file is line-delimited JSON we could actually read back.
 *
 * A copy that hashes correctly but is not parseable is still a bad archive, and
 * section 20 forbids claiming success without checking (PRD v0.2).
 */
/**
 * The most this will hold in memory to parse one line.
 *
 * The same cap and the same search offset `readLines` carries. This copy had
 * neither: `buffer.indexOf` rescanned the whole buffer on every chunk, so a
 * file with no newline in it was quadratic and unbounded. Measured on this
 * path, which `writeArchive` runs on every archive and the Stop hook runs
 * after every assistant turn: 128 MB took 45 s, 256 MB took 163 s, and 600 MB
 * was still going at 300 s with 1.9 GB resident. Claude's hook timeout is 60 s.
 *
 * The first version of the cap refused the whole file, which was the same
 * mistake this project keeps making in a new place: a Claude transcript can
 * legitimately carry one enormous record - a large tool result, a pasted file -
 * and `archive` and `pin` then refused to preserve a perfectly real session.
 * A line too long to hold is a line this check cannot judge, which is not the
 * same as a line that is wrong.
 */
const MAX_LINE_BYTES = 8 * 1024 * 1024;

export type JsonlCheck = {
  /** Every line this check could read parsed, and at least one did. */
  readable: boolean;
  /** Lines too long to hold in memory, so neither parsed nor rejected. */
  unchecked: number;
};

/** Convenience for callers that only need the verdict. */
export async function isReadableJsonl(path: string): Promise<boolean> {
  return (await checkJsonl(path)).readable;
}

export async function checkJsonl(path: string): Promise<JsonlCheck> {
  const handle = await openRegularFile(path);
  if (handle === undefined) return { readable: false, unchecked: 0 };
  try {
    const stream = handle.createReadStream({ encoding: "utf8" });
    let buffer = "";
    let searched = 0;
    let sawRecord = false;
    let unchecked = 0;
    let skipping = false;

    for await (const chunk of stream) {
      buffer += chunk as string;
      let index: number;
      while ((index = buffer.indexOf("\n", searched)) !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        searched = 0;
        if (skipping) {
          // The tail of a line we gave up on. Counted once, at the point we
          // gave up, not again here.
          skipping = false;
          continue;
        }
        if (line === "") continue;
        try {
          JSON.parse(line);
          sawRecord = true;
        } catch {
          return { readable: false, unchecked };
        }
      }
      searched = buffer.length;
      // Past the cap: stop accumulating, count it, and resume at the next
      // newline. The copy is still verified byte for byte by its checksum.
      if (buffer.length > MAX_LINE_BYTES) {
        // Counted once per record, at the point we give up on it. Without the
        // guard a single 24 MB record was reported as two, and a 600 MB line
        // as seventy-four - a statement of fact that was not one.
        if (!skipping) unchecked += 1;
        skipping = true;
        buffer = "";
        searched = 0;
      }
    }

    const tail = skipping ? "" : buffer.trim();
    if (tail !== "") {
      try {
        JSON.parse(tail);
        sawRecord = true;
      } catch {
        return { readable: false, unchecked };
      }
    }
    // A file that is nothing but one over-long line has nothing this check can
    // speak for, so it is not called readable - but it is counted, not guessed.
    return { readable: sawRecord, unchecked };
  } finally {
    await handle.close();
  }
}
