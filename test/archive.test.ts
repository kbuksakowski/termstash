import { stat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256File } from "../src/core/archive/integrity.js";
import { readArchive, writeArchive } from "../src/core/archive/store.js";
import type { ArchiveSource } from "../src/core/archive/store.js";
import { archiveDir } from "../src/core/paths.js";
import { conversation, writeTranscript } from "./helpers/sandbox.js";

const ID = "aaaaaaaa-0000-4000-8000-000000000001";
const CWD = "/tmp/backend_api";
const NOW = new Date("2026-09-12T12:00:00.000Z");

function home(): string {
  const value = process.env["TERMSTASH_HOME"];
  if (value === undefined) throw new Error("TERMSTASH_HOME not set");
  return value;
}

async function source(path: string, overrides: Partial<ArchiveSource> = {}): Promise<ArchiveSource> {
  const info = await stat(path);
  return {
    sessionId: ID,
    sourcePath: path,
    sizeBytes: info.size,
    mtime: info.mtime,
    projectPath: CWD,
    projectDirName: "-tmp-backend-api",
    claudeVersions: ["2.1.263"],
    ...overrides,
  };
}

async function seedTranscript(prompt = "fix the webhook"): Promise<string> {
  return writeTranscript({
    id: ID,
    cwd: CWD,
    records: conversation({ id: ID, cwd: CWD, prompt }),
  });
}

describe("writeArchive", () => {
  it("copies, verifies and records the source mtime", async () => {
    const path = await seedTranscript();
    const outcome = await writeArchive(home(), await source(path), { now: NOW });

    expect(outcome.status).toBe("created");
    if (outcome.status !== "created") return;

    const manifest = outcome.archive.manifest;
    expect(manifest.transcriptSha256).toBe(await sha256File(path));
    expect(manifest.sourceMtime).toBe((await stat(path)).mtime.toISOString());
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.projectDirName).toBe("-tmp-backend-api");
  });

  it("leaves the original untouched", async () => {
    const path = await seedTranscript();
    const before = await readFile(path, "utf8");
    const beforeStat = await stat(path);
    await writeArchive(home(), await source(path), { now: NOW });
    expect(await readFile(path, "utf8")).toBe(before);
    expect((await stat(path)).mtime.getTime()).toBe(beforeStat.mtime.getTime());
  });

  it("keeps archive files private to the user", async () => {
    const path = await seedTranscript();
    const outcome = await writeArchive(home(), await source(path), { now: NOW });
    if (outcome.status !== "created") throw new Error("expected created");
    const mode = (await stat(outcome.archive.transcriptPath)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("does nothing when the archive already matches", async () => {
    const path = await seedTranscript();
    await writeArchive(home(), await source(path), { now: NOW });
    const second = await writeArchive(home(), await source(path), { now: NOW });
    expect(second.status).toBe("already-current");
  });

  it("refuses to overwrite silently once the transcript has moved on", async () => {
    const path = await seedTranscript();
    await writeArchive(home(), await source(path), { now: NOW });
    await writeFile(path, `${await readFile(path, "utf8")}{"type":"mode","mode":"normal"}\n`);
    const second = await writeArchive(home(), await source(path), { now: NOW });
    expect(second.status).toBe("stale-refused");
  });

  it("refreshes only when asked, and keeps the newer content", async () => {
    const path = await seedTranscript();
    await writeArchive(home(), await source(path), { now: NOW });
    await writeFile(path, `${await readFile(path, "utf8")}{"type":"mode","mode":"plan"}\n`);

    const refreshed = await writeArchive(home(), await source(path), {
      replace: true,
      now: new Date(NOW.getTime() + 60_000),
    });
    expect(refreshed.status).toBe("refreshed");
    if (refreshed.status !== "refreshed") return;

    expect(refreshed.archive.manifest.refreshCount).toBe(1);
    expect(refreshed.archive.manifest.transcriptSha256).toBe(await sha256File(path));
    expect(await readFile(refreshed.archive.transcriptPath, "utf8")).toContain("plan");
  });

  it("leaves no staging or retired directories behind", async () => {
    const path = await seedTranscript();
    await writeArchive(home(), await source(path), { now: NOW });
    await writeFile(path, `${await readFile(path, "utf8")}{"type":"mode","mode":"plan"}\n`);
    await writeArchive(home(), await source(path), { replace: true, now: NOW });

    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(join(home(), "archive"));
    expect(entries).toEqual([ID]);
  });

  it("fails without writing when the source is not readable JSONL", async () => {
    const path = await seedTranscript();
    await writeFile(path, "this is not json at all\n");
    const outcome = await writeArchive(home(), await source(path), { now: NOW });
    expect(outcome.status).toBe("failed");
    expect(await readArchive(home(), ID)).toBeUndefined();
  });

  it("does not leave a half-written archive directory after a failure", async () => {
    const path = await seedTranscript();
    await writeFile(path, "broken\n");
    await writeArchive(home(), await source(path), { now: NOW });
    const { access } = await import("node:fs/promises");
    await expect(access(archiveDir(home(), ID))).rejects.toThrow();
  });
});
