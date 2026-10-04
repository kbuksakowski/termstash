import { appendFile, mkdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverSessions } from "../src/adapters/claude/discover.js";
import { findOrphans } from "../src/adapters/claude/orphans.js";
import { fileHistoryDir, projectsDir, sessionEnvDir } from "../src/adapters/claude/paths.js";
import { writeArchive } from "../src/core/archive/store.js";
import { compareVersions, runDoctor } from "../src/core/doctor/run.js";
import type { DoctorReport } from "../src/core/doctor/types.js";
import { updateSession } from "../src/core/metadata/store.js";
import { conversation, encodeProjectDir, root, writeRaw, writeTranscript } from "./helpers/sandbox.js";

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const CWD = "/tmp/backend_api";
const NOW = new Date("2026-09-12T12:00:00.000Z");

function home(): string {
  const value = process.env["TERMSTASH_HOME"];
  if (value === undefined) throw new Error("TERMSTASH_HOME not set");
  return value;
}

async function report(): Promise<DoctorReport> {
  const discovery = await discoverSessions({ root: root(), now: NOW });
  const orphans = await findOrphans(root(), new Set(discovery.sessions.map((s) => s.id)));
  return runDoctor({
    sessions: discovery.sessions,
    artifacts: discovery.artifacts,
    unreadable: discovery.unreadable,
    orphans,
    termstashRoot: home(),
  });
}

const codes = (r: DoctorReport) => r.findings.map((f) => f.code);
const find = (r: DoctorReport, code: string) => r.findings.find((f) => f.code === code);

async function healthy(id = A): Promise<string> {
  return writeTranscript({
    id,
    cwd: CWD,
    records: conversation({ id, cwd: CWD, prompt: "fix the webhook" }),
  });
}

describe("doctor: confirmed findings", () => {
  it("reports a session id that exists in two project directories", async () => {
    await healthy();
    await writeTranscript({
      id: A,
      cwd: "/tmp/elsewhere",
      records: conversation({ id: A, cwd: "/tmp/elsewhere", prompt: "same id" }),
    });
    const r = await report();
    expect(codes(r)).toContain("duplicate-session-id");
    expect(find(r, "duplicate-session-id")?.class).toBe("confirmed");
  });

  it("reports an empty transcript", async () => {
    await writeRaw(encodeProjectDir(CWD), `${A}.jsonl`, "");
    expect(codes(await report())).toContain("zero-byte-transcript");
  });

  it("reports a transcript with no conversation in it", async () => {
    await writeTranscript({
      id: A,
      cwd: CWD,
      records: [{ type: "bridge-session", sessionId: A, bridgeSessionId: "cse_x" }],
    });
    expect(codes(await report())).toContain("no-conversation");
  });

  it("reports genuinely malformed lines", async () => {
    const path = await healthy();
    await appendFile(path, "{ this is not json\n");
    expect(codes(await report())).toContain("unparsable-lines");
  });

  it("does NOT report a large healthy transcript as malformed", async () => {
    // Regression: the head reader stops once it has what it needs, leaving a
    // partial line in the buffer. Counting that as malformed reported almost
    // every real transcript as corrupt.
    const filler = Array.from({ length: 400 }, (_, i) => ({
      type: "file-history-snapshot",
      messageId: `m${i}`,
      snapshot: { trackedFileBackups: { blob: "x".repeat(3000) } },
    }));
    await writeTranscript({
      id: A,
      cwd: CWD,
      records: [...conversation({ id: A, cwd: CWD, prompt: "hello" }), ...filler],
    });
    expect(codes(await report())).not.toContain("unparsable-lines");
  });

  it("reports orphaned per-session directories", async () => {
    await healthy();
    await mkdir(join(sessionEnvDir(root()), B), { recursive: true });
    await mkdir(join(fileHistoryDir(root()), B), { recursive: true });
    await mkdir(join(projectsDir(root()), encodeProjectDir(CWD), B, "subagents"), {
      recursive: true,
    });

    const r = await report();
    expect(codes(r)).toContain("orphaned-session-env");
    expect(codes(r)).toContain("orphaned-file-history");
    expect(codes(r)).toContain("orphaned-sidecar");
  });

  it("does not call a live session's own sidecar an orphan", async () => {
    await healthy();
    await mkdir(join(projectsDir(root()), encodeProjectDir(CWD), A, "subagents"), {
      recursive: true,
    });
    expect(codes(await report())).not.toContain("orphaned-sidecar");
  });

  it("reports an archive whose checksum no longer matches", async () => {
    const path = await healthy();
    const info = await stat(path);
    const outcome = await writeArchive(home(), {
      sessionId: A, sourcePath: path, sizeBytes: info.size, mtime: info.mtime,
      projectDirName: encodeProjectDir(CWD), claudeVersions: ["2.1.263"],
    }, { now: NOW });
    if (outcome.status !== "created") throw new Error("expected created");
    await writeFile(outcome.archive.transcriptPath, '{"type":"mode","mode":"tampered"}\n');

    expect(codes(await report())).toContain("archive-checksum-mismatch");
  });

  it("reports a pinned session that is not actually protected", async () => {
    await healthy();
    await updateSession(home(), A, (current) => ({ ...current, pinned: true }));
    const r = await report();
    expect(codes(r)).toContain("pinned-not-protected");
    expect(find(r, "pinned-not-protected")?.class).toBe("confirmed");
  });
});

describe("doctor: potential findings", () => {
  it("flags a set-aside artifact without resuming or touching it", async () => {
    await writeRaw(encodeProjectDir(CWD), `${B}.orphaned-1234-abc.jsonl`, "{}\n");
    const r = await report();
    expect(find(r, "recoverable-artifact")?.class).toBe("potential");
  });

  it("flags record types it has never seen", async () => {
    // A deliberately invented type: using a real one would make this test pass
    // or fail depending on which Claude build the fixtures were recorded from.
    const records = conversation({ id: A, cwd: CWD, prompt: "hello" });
    records.push({ type: "not-a-real-record-type", sessionId: A });
    await writeTranscript({ id: A, cwd: CWD, records });

    const r = await report();
    expect(find(r, "unknown-record-types")?.details).toContain("not-a-real-record-type");
    expect(find(r, "unknown-record-types")?.class).toBe("potential");
  });

  it("does not flag a record type that shipped in a verified Claude build", async () => {
    // pr-link appeared in 2.1.269 and is now recorded as known; a doctor that
    // keeps warning about it would train the user to ignore the warning.
    const records = conversation({ id: A, cwd: CWD, prompt: "hello" });
    records.push({ type: "pr-link", sessionId: A, url: "https://example.test/pr/1" });
    await writeTranscript({ id: A, cwd: CWD, records });

    expect(codes(await report())).not.toContain("unknown-record-types");
  });

  it("flags a Claude newer than the verified build once, not per session", async () => {
    for (const id of [A, B]) {
      await writeTranscript({
        id,
        cwd: CWD,
        records: conversation({ id, cwd: CWD, prompt: "hi", version: "2.1.999" }),
      });
    }
    const r = await report();
    const finding = find(r, "newer-claude-version");
    expect(finding?.class).toBe("potential");
    expect(finding?.details).toEqual(["2.1.999"]);
  });
});

describe("doctor: informational findings", () => {
  it("separates retention facts from problems", async () => {
    await writeTranscript({
      id: A,
      cwd: CWD,
      mtime: new Date(NOW.getTime() - 26 * 86_400_000),
      records: conversation({ id: A, cwd: CWD, prompt: "old work" }),
    });
    const r = await report();
    expect(find(r, "approaching-cutoff")?.class).toBe("informational");
  });

  it("treats an archive with no live transcript as the archive working", async () => {
    const path = await healthy();
    const info = await stat(path);
    await writeArchive(home(), {
      sessionId: A, sourcePath: path, sizeBytes: info.size, mtime: info.mtime,
      projectDirName: encodeProjectDir(CWD), claudeVersions: ["2.1.263"],
    }, { now: NOW });
    const { rm } = await import("node:fs/promises");
    await rm(path);

    const r = await report();
    expect(find(r, "archive-without-live-session")?.class).toBe("informational");
  });
});

describe("doctor: a clean machine", () => {
  it("reports nothing when nothing is wrong", async () => {
    await healthy();
    const r = await report();
    expect(r.findings.filter((f) => f.class === "confirmed")).toEqual([]);
    expect(r.sessionCount).toBe(1);
  });
});

describe("compareVersions", () => {
  it("orders dotted versions numerically, not lexically", () => {
    expect(compareVersions("2.1.9", "2.1.10")).toBe(-1);
    expect(compareVersions("2.1.263", "2.1.263")).toBe(0);
    expect(compareVersions("2.2.0", "2.1.999")).toBe(1);
  });

  it("never calls an unparseable version newer", () => {
    expect(compareVersions("weird", "2.1.263")).toBe(0);
  });
});

describe("an archive nothing can read", () => {
  /**
   * Rejecting a bad manifest is right; hiding it is not. An archive the user
   * believes protects a session, that no command will ever restore, is the
   * exact failure this tool exists to make visible — so doctor names it.
   */
  it("reports an archive whose manifest will not parse", async () => {
    await mkdir(join(home(), "archive", A), { recursive: true });
    await writeFile(join(home(), "archive", A, "transcript.jsonl"), "{}\n");
    await writeFile(join(home(), "archive", A, "manifest.json"), "{ not json");

    const finding = (await report()).findings.find((f) => f.code === "archive-manifest-unreadable");
    expect(finding?.class).toBe("confirmed");
    expect(finding?.summary).toMatch(/will not restore/);
    expect(finding?.details.join(" ")).toContain(A);
  });

  it("says nothing when every manifest reads cleanly", async () => {
    const path = await writeTranscript({ id: A, cwd: CWD, records: conversation({ id: A, cwd: CWD, prompt: "hi" }) });
    const info = await stat(path);
    await writeArchive(home(), {
      sessionId: A, sourcePath: path, sizeBytes: info.size, mtime: info.mtime,
      claudeVersions: ["2.1.269"], projectPath: CWD, projectDirName: encodeProjectDir(CWD),
    }, { now: NOW });

    expect((await report()).findings.some((f) => f.code === "archive-manifest-unreadable")).toBe(false);
  });
});

/**
 * Found on a real machine, not in a sandbox: doctor announced two archives as
 * differing from their live session "but not marked stale" when both differed
 * in size, mtime and bytes — the ordinary case, already shown as a hollow star
 * and already reported as a protection failure. The check compared checksums
 * and claimed a condition that also requires the size and mtime to agree.
 */
describe("doctor tells the three archive states apart", () => {
  async function archived(id = A): Promise<string> {
    const path = await healthy(id);
    const info = await stat(path);
    await writeArchive(home(), {
      sessionId: id,
      sourcePath: path,
      sizeBytes: info.size,
      mtime: info.mtime,
      projectPath: CWD,
      projectDirName: encodeProjectDir(CWD),
      claudeVersions: [],
    });
    return path;
  }

  it("calls it invisible only when size and mtime agree and the bytes do not", async () => {
    const path = await archived();
    const info = await stat(path);
    const body = await readFile(path, "utf8");
    // Same length, same timestamp, different bytes: what restoring a backup
    // over a transcript produces, and the one state nothing else can see.
    await writeFile(path, body.replace(/fix the webhook/, "fix the webhooX"));
    await utimes(path, info.mtime, info.mtime);
    expect((await stat(path)).size).toBe(info.size);

    const r = await report();
    expect(codes(r)).toContain("archive-diverged-from-live");
    expect(find(r, "archive-diverged-from-live")?.class).toBe("confirmed");
    expect(codes(r)).not.toContain("archive-behind-live");
  });

  it("calls an ordinary stale archive behind, not invisible", async () => {
    const path = await archived();
    await appendFile(path, `${JSON.stringify({ type: "mode", mode: "plan" })}\n`);

    const r = await report();
    expect(codes(r)).not.toContain("archive-diverged-from-live");
    expect(codes(r)).toContain("archive-behind-live");
    expect(find(r, "archive-behind-live")?.class).toBe("informational");
  });

  it("says nothing twice: a pinned stale archive is a protection finding only", async () => {
    const path = await archived();
    await updateSession(home(), A, (current) => ({ ...current, pinned: true }));
    await appendFile(path, `${JSON.stringify({ type: "mode", mode: "plan" })}\n`);

    const r = await report();
    expect(codes(r)).toContain("pinned-not-protected");
    expect(codes(r)).not.toContain("archive-behind-live");
    expect(codes(r)).not.toContain("archive-diverged-from-live");
  });

  it("separates a timestamp that moved from bytes that changed", async () => {
    const path = await archived();
    const later = new Date("2026-09-12T13:00:00.000Z");
    await utimes(path, later, later);

    const r = await report();
    expect(codes(r)).toContain("archive-timestamp-only");
    expect(codes(r)).not.toContain("archive-diverged-from-live");
    expect(codes(r)).not.toContain("archive-behind-live");
  });

  it("stays quiet when the archive matches", async () => {
    await archived();
    const r = await report();
    expect(codes(r)).not.toContain("archive-diverged-from-live");
    expect(codes(r)).not.toContain("archive-behind-live");
    expect(codes(r)).not.toContain("archive-timestamp-only");
  });
});
