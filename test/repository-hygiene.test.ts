import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * What must never be committed to this repository, checked by shape.
 *
 * Shapes only, never names. A list of the words that must stay out of a
 * public repository would publish exactly those words; that list lives in a
 * maintainer's local pre-commit hook, outside the repository. What can be
 * checked here is what a leak or a leftover looks like: a home directory that
 * is not the invented `/Users/you`, a macOS temporary directory, a file named
 * like a session, an editor or OS artefact, something unexpectedly large.
 *
 * Every rule here exists because the shape got in once. Ten files named by
 * session id sat at the repository root, committed by a `git add -A` after a
 * measurement run from this directory.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function tracked(): string[] | undefined {
  try {
    return execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
      .split("\0")
      .filter((f) => f !== "");
  } catch {
    return undefined; // an unpacked tarball, not a checkout: nothing to police
  }
}

const files = tracked();
const run = files === undefined ? describe.skip : describe;

/** Home directories the fixtures, demos and tests invent. Anything else is real. */
const INVENTED_HOMES = new Set(["you", "fixture", "name", "someone", "x", "a"]);
const MAX_BYTES = 1024 * 1024;

function text(file: string): string | undefined {
  if (/\.(gif|png|jpe?g|ico)$/i.test(file)) return undefined;
  return readFileSync(join(ROOT, file), "utf8");
}

run("repository hygiene", () => {
  it("has no file named like a Claude session", () => {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.jsonl)?$/;
    expect(files!.filter((f) => uuid.test(basename(f)))).toEqual([]);
  });

  it("has no operating-system, editor or environment leftovers", () => {
    const junk = /(^|\/)(\.DS_Store|Thumbs\.db|\.env(\..*)?|.*\.(log|orig|bak|swp|tmp)|.*~)$|\.termstash-[0-9a-f]{8}$/;
    expect(files!.filter((f) => junk.test(f))).toEqual([]);
  });

  it("has nothing unexpectedly large", () => {
    const large = files!.filter((f) => statSync(join(ROOT, f)).size > MAX_BYTES);
    expect(large).toEqual([]);
  });

  it("names no real home directory, in either spelling", () => {
    // `/Users/name` as written, and `-Users-name` as Claude encodes it into a
    // project directory name - the second is the one that got past a check
    // looking only for the first.
    const home = /\/(?:Users|home)\/([A-Za-z0-9._-]+)|-(?:Users|home)-([A-Za-z0-9]+)/g;
    const found: string[] = [];
    for (const file of files!) {
      const body = text(file);
      if (body === undefined) continue;
      for (const match of body.matchAll(home)) {
        const who = match[1] ?? match[2] ?? "";
        if (!INVENTED_HOMES.has(who)) found.push(`${file}: ${match[0]}`);
      }
    }
    expect(found).toEqual([]);
  });

  it("names no macOS temporary or per-user cache directory", () => {
    const temp = /\/var\/folders\/|\/private\/var\/|claude-\d{3}\b|\.npm\/_logs/;
    const found = files!.filter((f) => {
      const body = text(f);
      return body !== undefined && temp.test(body);
    });
    expect(found).toEqual([]);
  });
});
