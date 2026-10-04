import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { containedPath } from "../src/core/fs/contain.js";

/**
 * path.resolve folds ".." but does not follow links, so a containment check
 * built on it passed a symlinked directory straight through - and lstat'ing
 * only the final component missed a symlinked ancestor entirely. Both shapes
 * are here, plus the ordinary case of a leaf that does not exist yet, which is
 * what a restore target normally is.
 */
let dirs: string[] = [];

async function sandbox(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ts-contain-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

describe("containedPath", () => {
  it("accepts a path inside the root", async () => {
    const root = await sandbox();
    await mkdir(join(root, "bucket"));
    expect(await containedPath(root, join(root, "bucket"))).toBeDefined();
  });

  it("accepts a leaf that does not exist yet", async () => {
    const root = await sandbox();
    expect(await containedPath(root, join(root, "not", "there", "yet"))).toBeDefined();
  });

  it("rejects a lexical escape", async () => {
    const root = await sandbox();
    expect(await containedPath(root, join(root, "..", "elsewhere"))).toBeUndefined();
  });

  it("rejects a symlinked leaf, which resolve() would have allowed", async () => {
    const root = await sandbox();
    const outside = await sandbox();
    execFileSync("ln", ["-s", outside, join(root, "bucket")]);

    expect(await containedPath(root, join(root, "bucket"))).toBeUndefined();
  });

  it("rejects a symlinked ancestor, which one lstat would have missed", async () => {
    const root = await sandbox();
    const outside = await sandbox();
    await mkdir(join(outside, "real"));
    execFileSync("ln", ["-s", join(outside, "real"), join(root, "middle")]);

    expect(await containedPath(root, join(root, "middle", "leaf"))).toBeUndefined();
  });

  it("rejects when the root itself cannot be resolved", async () => {
    const root = await sandbox();
    expect(await containedPath(join(root, "missing"), join(root, "missing", "x"))).toBeUndefined();
  });

  it("follows a symlinked root, because that is the user's own choice", async () => {
    // A ~/.claude/projects moved to another disk is a legitimate setup, and
    // Claude itself would read from there. Refusing it would break the case
    // rather than protect it: an attacker able to create that link already has
    // write access to the directory being protected.
    const real = await sandbox();
    const home = await sandbox();
    const root = join(home, "projects");
    execFileSync("ln", ["-s", real, root]);
    await writeFile(join(real, "marker"), "x");

    expect(await containedPath(root, join(root, "bucket"))).toBeDefined();
  });
});
