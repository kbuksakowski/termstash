import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createExclusiveFile, openRegularFile } from "../src/core/fs/regular.js";
import { isReadableJsonl, sha256File } from "../src/core/archive/integrity.js";

/**
 * Three hangs came from opening a path by name and asking what it was
 * afterwards. A FIFO blocks inside open(), so the check never ran - and the
 * process could not even exit, because process.exit() does not return while a
 * libuv thread is parked in the syscall. Only SIGKILL ended it.
 *
 * Every test here would hang rather than fail if the primitive regressed, so
 * each one is also a liveness test for the suite itself.
 */
let dirs: string[] = [];

async function sandbox(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ts-regular-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

describe("openRegularFile", () => {
  it("opens an ordinary file", async () => {
    const dir = await sandbox();
    const path = join(dir, "ok.txt");
    await writeFile(path, "hello\n");

    const handle = await openRegularFile(path);
    expect(handle).toBeDefined();
    await handle?.close();
  });

  it("refuses a FIFO instead of blocking on it", async () => {
    const dir = await sandbox();
    const path = join(dir, "pipe");
    execFileSync("mkfifo", [path]);

    expect(await openRegularFile(path)).toBeUndefined();
  });

  it("refuses a character device", async () => {
    expect(await openRegularFile("/dev/zero")).toBeUndefined();
  });

  it("refuses a symlink, whatever it points at", async () => {
    const dir = await sandbox();
    const real = join(dir, "real.txt");
    const link = join(dir, "link.txt");
    await writeFile(real, "hello\n");
    execFileSync("ln", ["-s", real, link]);

    expect(await openRegularFile(link)).toBeUndefined();
  });

  it("refuses a directory and a missing path", async () => {
    const dir = await sandbox();
    expect(await openRegularFile(dir)).toBeUndefined();
    expect(await openRegularFile(join(dir, "nope"))).toBeUndefined();
  });
});

describe("createExclusiveFile", () => {
  it("refuses a path that already exists, including a symlink", async () => {
    const dir = await sandbox();
    const taken = join(dir, "taken");
    await writeFile(taken, "x");
    expect(await createExclusiveFile(taken, 0o600)).toBeUndefined();

    const link = join(dir, "link");
    execFileSync("ln", ["-s", join(dir, "elsewhere"), link]);
    expect(await createExclusiveFile(link, 0o600)).toBeUndefined();
  });
});

describe("readers that used to open by name", () => {
  it("sha256File refuses a FIFO rather than hanging", async () => {
    const dir = await sandbox();
    const path = join(dir, "pipe");
    execFileSync("mkfifo", [path]);

    await expect(sha256File(path)).rejects.toThrow(/could not be read as an ordinary file/);
  });

  it("isReadableJsonl refuses a FIFO rather than hanging", async () => {
    const dir = await sandbox();
    const path = join(dir, "pipe");
    execFileSync("mkfifo", [path]);

    expect(await isReadableJsonl(path)).toBe(false);
  });
});
