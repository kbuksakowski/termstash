import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { projectsDir } from "../src/adapters/claude/paths.js";
import { scanTranscripts } from "../src/adapters/claude/scan.js";
import { restoreArchive } from "../src/core/archive/restore.js";
import { readArchive, writeArchive } from "../src/core/archive/store.js";
import type { StoredArchive } from "../src/core/archive/store.js";
import { quarantineRoot } from "../src/core/paths.js";
import { conversation, root, writeTranscript } from "./helpers/sandbox.js";

const ID = "aaaaaaaa-0000-4000-8000-000000000001";
const CWD = "/tmp/backend_api";
const DIR_NAME = "-tmp-backend-api";
const NOW = new Date("2026-09-12T12:00:00.000Z");
const LONG_AGO = new Date("2026-06-01T09:00:00.000Z");

function home(): string {
  const value = process.env["TERMSTASH_HOME"];
  if (value === undefined) throw new Error("TERMSTASH_HOME not set");
  return value;
}

function targetDir(): string {
  return join(projectsDir(root()), DIR_NAME);
}

/** Archive a session, then remove the live transcript as Claude's sweep would. */
async function archived(options: { keepLive?: boolean; mtime?: Date } = {}): Promise<StoredArchive> {
  const path = await writeTranscript({
    id: ID,
    cwd: CWD,
    mtime: options.mtime ?? LONG_AGO,
    records: conversation({ id: ID, cwd: CWD, prompt: "fix the webhook", customTitle: "Stripe" }),
  });
  const info = await stat(path);
  const outcome = await writeArchive(
    home(),
    {
      sessionId: ID,
      sourcePath: path,
      sizeBytes: info.size,
      mtime: info.mtime,
      projectPath: CWD,
      projectDirName: DIR_NAME,
      claudeVersions: ["2.1.263"],
    },
    { now: NOW },
  );
  if (outcome.status !== "created") throw new Error(`expected created, got ${outcome.status}`);
  if (options.keepLive !== true) await rm(path);
  return outcome.archive;
}

const base = (archive: StoredArchive) => ({
  archive,
  isLive: false,
  targetDir: targetDir(),
      containedWithin: projectsDir(root()),
  termstashRoot: home(),
  now: NOW,
});

describe("restoreArchive", () => {
  it("restores when Claude has already swept the transcript", async () => {
    const archive = await archived();
    const outcome = await restoreArchive({ ...base(archive), existing: [] });

    expect(outcome.status).toBe("restored");
    if (outcome.status !== "restored") return;
    expect(await readFile(outcome.path, "utf8")).toContain("fix the webhook");

    const scan = await scanTranscripts(root());
    expect(scan.transcripts.filter((t) => t.id === ID)).toHaveLength(1);
  });

  it("gives the restored transcript the CURRENT mtime, not the archived one", async () => {
    // The correction that made this phase worth shipping. Claude's sweep
    // deletes by mtime, so restoring the original would make the file eligible
    // for deletion at Claude's next launch and silently undo the restore.
    const archive = await archived();
    expect(archive.manifest.sourceMtime).toBe(LONG_AGO.toISOString());

    const outcome = await restoreArchive({ ...base(archive), existing: [] });
    if (outcome.status !== "restored") throw new Error("expected restored");

    const restored = await stat(outcome.path);
    expect(restored.mtime.getTime()).toBe(NOW.getTime());
    expect(restored.mtime.getTime()).not.toBe(LONG_AGO.getTime());
  });

  it("creates the project directory when it is gone", async () => {
    const archive = await archived();
    await rm(targetDir(), { recursive: true, force: true });
    const outcome = await restoreArchive({ ...base(archive), existing: [] });
    expect(outcome.status).toBe("restored");
  });

  it("refuses while the session is open in another Claude process", async () => {
    const archive = await archived();
    const outcome = await restoreArchive({ ...base(archive), existing: [], isLive: true });
    expect(outcome.status).toBe("refused");
    if (outcome.status === "refused") expect(outcome.reason).toMatch(/currently active/);
  });

  it("refuses when a transcript already exists, and changes nothing", async () => {
    const archive = await archived({ keepLive: true });
    const live = join(targetDir(), `${ID}.jsonl`);
    const before = await readFile(live, "utf8");

    const outcome = await restoreArchive({ ...base(archive), existing: [{ path: live }] });
    expect(outcome.status).toBe("refused");
    if (outcome.status === "refused") expect(outcome.reason).toMatch(/--replace/);
    expect(await readFile(live, "utf8")).toBe(before);
  });

  it("refuses a duplicate state outright, with or without --replace", async () => {
    // Claude reports not-found when two projects hold the same id. TermStash
    // cannot know which copy is real, so guessing would destroy the wrong one.
    const archive = await archived();
    const other = join(projectsDir(root()), "-tmp-elsewhere");
    await mkdir(other, { recursive: true });
    await writeFile(join(other, `${ID}.jsonl`), "{}\n");

    const existing = [{ path: join(targetDir(), `${ID}.jsonl`) }, { path: join(other, `${ID}.jsonl`) }];
    for (const replace of [false, true]) {
      const outcome = await restoreArchive({ ...base(archive), existing, replace });
      expect(outcome.status).toBe("refused");
      if (outcome.status === "refused") expect(outcome.reason).toMatch(/multiple Claude project/);
    }
  });

  it("quarantines the displaced transcript instead of deleting it", async () => {
    const archive = await archived({ keepLive: true });
    const live = join(targetDir(), `${ID}.jsonl`);
    await writeFile(live, `${await readFile(live, "utf8")}{"type":"mode","mode":"plan"}\n`);
    const displaced = await readFile(live, "utf8");

    const outcome = await restoreArchive({
      ...base(archive),
      existing: [{ path: live }],
      replace: true,
    });

    expect(outcome.status).toBe("restored");
    if (outcome.status !== "restored") return;
    expect(outcome.quarantinedTo).toBeDefined();

    const held = join(outcome.quarantinedTo ?? "", "transcript.jsonl");
    expect(await readFile(held, "utf8")).toBe(displaced);

    const origin = JSON.parse(await readFile(join(outcome.quarantinedTo ?? "", "origin.json"), "utf8"));
    expect(origin.reason).toBe("replaced-by-restore");
    expect(origin.originalPath).toBe(live);

    // And exactly one live transcript remains, which is the whole point.
    const scan = await scanTranscripts(root());
    expect(scan.transcripts.filter((t) => t.id === ID)).toHaveLength(1);
    expect(await readFile(live, "utf8")).not.toContain("plan");
  });

  it("never prunes the quarantine on its own", async () => {
    const archive = await archived({ keepLive: true });
    const live = join(targetDir(), `${ID}.jsonl`);
    await restoreArchive({ ...base(archive), existing: [{ path: live }], replace: true });

    await writeTranscript({
      id: ID,
      cwd: CWD,
      records: conversation({ id: ID, cwd: CWD, prompt: "second round" }),
    });
    await restoreArchive({
      ...base(archive),
      existing: [{ path: live }],
      replace: true,
      now: new Date(NOW.getTime() + 60_000),
    });

    const held = await readdir(join(quarantineRoot(home()), ID));
    expect(held).toHaveLength(2);
  });

  it("removes the restored file and keeps the quarantine when verification fails", async () => {
    const archive = await archived();
    // Corrupt the archive after the manifest was written.
    await writeFile(archive.transcriptPath, '{"type":"mode","mode":"tampered"}\n');

    const outcome = await restoreArchive({ ...base(archive), existing: [] });
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") expect(outcome.reason).toMatch(/checksum/);

    const scan = await scanTranscripts(root());
    expect(scan.transcripts.filter((t) => t.id === ID)).toHaveLength(0);
  });
});

describe("protection state after a restore", () => {
  it("leaves a pinned session reading as protected, not stale", async () => {
    // The restored file and the archive are byte-identical, so anything else
    // is a false alarm - and it appeared at the worst moment, right when the
    // session came back.
    const archive = await archived();
    const outcome = await restoreArchive({ ...base(archive), existing: [] });
    expect(outcome.status).toBe("restored");
    if (outcome.status !== "restored") return;

    const { stat } = await import("node:fs/promises");
    const live = await stat(outcome.path);
    const refreshed = await readArchive(home(), ID);

    const { protectionState } = await import("../src/core/archive/protection.js");
    expect(
      protectionState({
        pinned: true,
        ...(refreshed !== undefined ? { manifest: refreshed.manifest } : {}),
        live: { sizeBytes: live.size, mtime: live.mtime },
      }),
    ).toBe("protected-current");
  });

  it("still detects staleness once the session is worked in again", async () => {
    const archive = await archived();
    const outcome = await restoreArchive({ ...base(archive), existing: [] });
    if (outcome.status !== "restored") throw new Error("expected restored");

    const { appendFile, stat } = await import("node:fs/promises");
    await appendFile(outcome.path, '{"type":"mode","mode":"plan"}\n');
    const live = await stat(outcome.path);
    const refreshed = await readArchive(home(), ID);

    const { protectionState } = await import("../src/core/archive/protection.js");
    expect(
      protectionState({
        pinned: true,
        ...(refreshed !== undefined ? { manifest: refreshed.manifest } : {}),
        live: { sizeBytes: live.size, mtime: live.mtime },
      }),
    ).toBe("protected-stale");
  });
});

describe("a manifest is input, not a fact", () => {
  /**
   * An archive is a directory that can be copied between machines, so its
   * manifest may have been written by someone else. `projectDirName` decides
   * where a restore lands, and one carrying `..` placed the transcript
   * anywhere the user could write — while reporting "restored and verified".
   */
  it.each([
    ["parent traversal", "../../../evil"],
    ["absolute-looking", "/etc/evil"],
    ["trailing traversal", "safe/../../.."],
    ["dot-dot alone", ".."],
    ["single dot", "."],
    ["empty after a separator", "a/b"],
  ])("refuses a projectDirName that is not one path segment: %s", async (_name, dirName) => {
    await archived();
    const manifestPath = join(home(), "archive", ID, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest["projectDirName"] = dirName;
    await writeFile(manifestPath, JSON.stringify(manifest));

    // Rejected outright: the archive does not parse, so nothing can act on it.
    expect(await readArchive(home(), ID)).toBeUndefined();
  });


  it.each([
    ["parent traversal", "../../../evil"],
    ["absolute-looking", "/etc/evil"],
    ["not a uuid", "just-a-name"],
    ["uuid with a tail", "aaaaaaaa-0000-4000-8000-000000000001/../../x"],
    ["empty", ""],
  ])("refuses a sessionId that is not a plain UUID: %s", async (_name, sessionId) => {
    await archived();
    const manifestPath = join(home(), "archive", ID, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest["sessionId"] = sessionId;
    await writeFile(manifestPath, JSON.stringify(manifest));

    expect(await readArchive(home(), ID)).toBeUndefined();
  });

  it("takes the id from the directory name, so the manifest cannot pick the file", async () => {
    // Even a well-formed UUID in the manifest must not decide where the write
    // lands: every guard in restoreArchive is computed from the directory name,
    // and the two disagreeing is how a live transcript got overwritten.
    const archive = await archived();
    const manifestPath = join(home(), "archive", ID, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest["sessionId"] = "bbbbbbbb-0000-4000-8000-000000000002";
    await writeFile(manifestPath, JSON.stringify(manifest));

    const reread = await readArchive(home(), ID);
    expect(reread).toBeDefined();
    const outcome = await restoreArchive({
      archive: reread ?? archive,
      existing: [],
      isLive: false,
      targetDir: targetDir(),
      containedWithin: projectsDir(root()),
      termstashRoot: home(),
      replace: false,
      now: NOW,
    });

    expect(outcome.status).toBe("restored");
    if (outcome.status === "restored") expect(outcome.path).toBe(join(targetDir(), `${ID}.jsonl`));
  });


  it("refuses an archive whose transcript could not be read as an ordinary file", async () => {
    // Opening a FIFO for reading blocks until a writer appears, which is never.
    // doctor computes a checksum for every archive, so one of these hung the
    // command you run precisely when you suspect something is wrong.
    await archived();
    const transcript = join(home(), "archive", ID, "transcript.jsonl");
    await rm(transcript);
    execFileSync("mkfifo", [transcript]);

    expect(await readArchive(home(), ID)).toBeUndefined();
  });


  it("still accepts the names Claude actually produces", async () => {
    await archived();
    const archive = await readArchive(home(), ID);
    expect(archive?.manifest.projectDirName).toBe(DIR_NAME);
  });
});
