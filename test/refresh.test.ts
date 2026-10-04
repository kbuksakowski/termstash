import { readFile, stat, writeFile, appendFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { sha256File } from "../src/core/archive/integrity.js";
import { readArchive, refreshArchive, writeArchive } from "../src/core/archive/store.js";
import type { ArchiveSource } from "../src/core/archive/store.js";
import { conversation, writeTranscript } from "./helpers/sandbox.js";

const ID = "aaaaaaaa-0000-4000-8000-000000000001";
const CWD = "/tmp/backend_api";
const NOW = new Date("2026-09-13T12:00:00.000Z");

function home(): string {
  const v = process.env["TERMSTASH_HOME"];
  if (v === undefined) throw new Error("TERMSTASH_HOME not set");
  return v;
}

async function src(path: string): Promise<ArchiveSource> {
  const info = await stat(path);
  return {
    sessionId: ID,
    sourcePath: path,
    sizeBytes: info.size,
    mtime: info.mtime,
    projectPath: CWD,
    projectDirName: "-tmp-backend-api",
    claudeVersions: ["2.1.269"],
  };
}

async function seed(): Promise<string> {
  return writeTranscript({
    id: ID,
    cwd: CWD,
    records: conversation({ id: ID, cwd: CWD, prompt: "fix the webhook" }),
  });
}

/**
 * These outlived the incremental path they were written for. They were never
 * about appending - they are the contract the hook depends on after every
 * assistant turn, and the contract did not change when the mechanism went.
 */
describe("refreshArchive", () => {
  it("ends up byte-identical to the live transcript after it grows", async () => {
    const path = await seed();
    await writeArchive(home(), await src(path), { now: NOW });
    await appendFile(path, '{"type":"mode","mode":"plan"}\n');

    const outcome = await refreshArchive(home(), await src(path), { now: NOW });
    expect(outcome.status).toBe("rewritten");

    const archive = await readArchive(home(), ID);
    expect(await readFile(archive?.transcriptPath ?? "", "utf8")).toBe(await readFile(path, "utf8"));
    expect(archive?.manifest.transcriptSha256).toBe(await sha256File(path));
    expect(archive?.manifest.refreshCount).toBe(1);
  });

  it("does nothing when already current", async () => {
    const path = await seed();
    await writeArchive(home(), await src(path), { now: NOW });
    expect((await refreshArchive(home(), await src(path), { now: NOW })).status).toBe("up-to-date");
  });

  it("refuses when the transcript is replaced rather than extended", async () => {
    const path = await seed();
    await writeArchive(home(), await src(path), { now: NOW });
    const rewritten = [
      ...conversation({ id: ID, cwd: CWD, prompt: "compacted summary" }),
      { type: "mode", mode: "plan", sessionId: ID },
    ];
    await writeFile(path, rewritten.map((r) => JSON.stringify(r)).join("\n") + "\n");

    // This used to fall back to a full rewrite, which was right while the
    // archive was only ever a cache of the live file. It is not a cache: it is
    // the copy that outlives the sweep, and `/compact` rewriting history is
    // exactly when its contents are the only ones left. An automatic refresh
    // refuses; `termstash archive <id> --replace` is where a person decides,
    // and that path quarantines what it displaces.
    const outcome = await refreshArchive(home(), await src(path), { now: NOW });
    expect(outcome.status).toBe("refused");

    const archive = await readArchive(home(), ID);
    expect(await readFile(archive?.transcriptPath ?? "", "utf8")).not.toBe(
      await readFile(path, "utf8"),
    );
    expect(await readFile(archive?.transcriptPath ?? "", "utf8")).toContain("fix the webhook");
  });

  it("creates the archive when there is none", async () => {
    const path = await seed();
    expect((await refreshArchive(home(), await src(path), { now: NOW })).status).toBe("rewritten");
    expect(await readArchive(home(), ID)).toBeDefined();
  });

  it("leaves the previous archive intact when the source vanishes mid-refresh", async () => {
    const path = await seed();
    await writeArchive(home(), await src(path), { now: NOW });
    const source = await src(path);
    const before = await readFile((await readArchive(home(), ID))?.transcriptPath ?? "", "utf8");

    const { rm } = await import("node:fs/promises");
    await rm(path);
    const outcome = await refreshArchive(home(), { ...source, sizeBytes: source.sizeBytes + 10 });
    expect(outcome.status).toBe("failed");
    expect(await readFile((await readArchive(home(), ID))?.transcriptPath ?? "", "utf8")).toBe(before);
  });
});
