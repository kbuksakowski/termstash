import { stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseTranscript } from "../src/adapters/claude/parse.js";
import { conversation, writeTranscript } from "./helpers/sandbox.js";

const ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const CWD = "/tmp/some_repo";

async function parse(path: string) {
  const { size } = await stat(path);
  return parseTranscript(path, size);
}

describe("parseTranscript", () => {
  it("extracts the metadata list depends on", async () => {
    const path = await writeTranscript({
      id: ID,
      cwd: CWD,
      records: conversation({ id: ID, cwd: CWD, prompt: "fix the webhook" }),
    });
    const parsed = await parse(path);

    expect(parsed.cwd).toBe(CWD);
    expect(parsed.gitBranch).toBe("main");
    expect(parsed.versions).toEqual(["2.1.263"]);
    expect(parsed.origin).toBe("interactive");
    expect(parsed.createdAt?.toISOString()).toBe("2026-09-01T10:00:00.000Z");
  });

  it("prefers a custom title over a generated one", async () => {
    const path = await writeTranscript({
      id: ID,
      cwd: CWD,
      records: conversation({
        id: ID,
        cwd: CWD,
        prompt: "fix the webhook",
        aiTitle: "Webhook fix",
        customTitle: "Stripe webhook",
      }),
    });
    const parsed = await parse(path);
    expect(parsed.title).toBe("Stripe webhook");
    expect(parsed.titleSource).toBe("custom");
  });

  it("uses the newest title record, since they are appended repeatedly", async () => {
    const records = conversation({ id: ID, cwd: CWD, prompt: "hello" });
    records.push({ type: "ai-title", aiTitle: "First guess", sessionId: ID });
    records.push({ type: "ai-title", aiTitle: "Better guess", sessionId: ID });
    const path = await writeTranscript({ id: ID, cwd: CWD, records });
    expect((await parse(path)).title).toBe("Better guess");
  });

  it("falls back to the first human prompt", async () => {
    const path = await writeTranscript({
      id: ID,
      cwd: CWD,
      records: conversation({ id: ID, cwd: CWD, prompt: "refactor the redis client" }),
    });
    const parsed = await parse(path);
    expect(parsed.title).toBe("refactor the redis client");
    expect(parsed.titleSource).toBe("first-prompt");
  });

  it("ignores meta, sidechain and tool-result turns when picking a prompt", async () => {
    const base = { sessionId: ID, cwd: CWD, version: "2.1.263", entrypoint: "cli" };
    const records = [
      { ...base, type: "user", isMeta: true, timestamp: "2026-09-01T10:00:00.000Z",
        message: { role: "user", content: "system noise" } },
      { ...base, type: "user", isSidechain: true, timestamp: "2026-09-01T10:00:01.000Z",
        message: { role: "user", content: "subagent turn" } },
      { ...base, type: "user", toolUseResult: { ok: true }, timestamp: "2026-09-01T10:00:02.000Z",
        message: { role: "user", content: "tool output" } },
      { ...base, type: "user", timestamp: "2026-09-01T10:00:03.000Z",
        message: { role: "user", content: "the real question" } },
    ];
    const path = await writeTranscript({ id: ID, cwd: CWD, records });
    expect((await parse(path)).title).toBe("the real question");
  });

  it("finds cwd past a long run of snapshot records", async () => {
    // The 256 KB head trap: two real transcripts opened with enough
    // file-history-snapshot records to fill a sampled window entirely.
    const filler = Array.from({ length: 60 }, (_, i) => ({
      type: "file-history-snapshot",
      messageId: `m${i}`,
      snapshot: { trackedFileBackups: { blob: "x".repeat(5000) } },
    }));
    const path = await writeTranscript({
      id: ID,
      cwd: CWD,
      records: [...filler, ...conversation({ id: ID, cwd: CWD, prompt: "late start" })],
    });
    const parsed = await parse(path);
    expect(parsed.cwd).toBe(CWD);
    expect(parsed.title).toBe("late start");
  });

  it("survives a degenerate transcript and says what is missing", async () => {
    const path = await writeTranscript({
      id: ID,
      cwd: CWD,
      records: [{ type: "bridge-session", sessionId: ID, bridgeSessionId: "cse_x" }],
    });
    const parsed = await parse(path);
    expect(parsed.cwd).toBeUndefined();
    expect(parsed.title).toBeUndefined();
    expect(parsed.warnings.join(" ")).toMatch(/no cwd/);
  });

  it("counts unparsable lines without failing the parse", async () => {
    const path = await writeTranscript({
      id: ID,
      cwd: CWD,
      records: conversation({ id: ID, cwd: CWD, prompt: "hello" }),
    });
    const { appendFile } = await import("node:fs/promises");
    await appendFile(path, "{ this is not json\n");
    const parsed = await parse(path);
    expect(parsed.cwd).toBe(CWD);
    expect(parsed.warnings.join(" ")).toMatch(/unparsable/);
  });

  it("records every cwd a session moved through", async () => {
    const records = conversation({ id: ID, cwd: CWD, prompt: "start here" });
    records.push({
      type: "user", sessionId: ID, cwd: "/tmp/elsewhere", version: "2.1.263",
      entrypoint: "cli", timestamp: "2026-09-02T10:00:00.000Z",
      message: { role: "user", content: "moved" },
    });
    const path = await writeTranscript({ id: ID, cwd: CWD, records });
    const parsed = await parse(path);
    expect(parsed.cwd).toBe(CWD);
    expect(parsed.cwdHistory).toContain("/tmp/elsewhere");
  });

  it("distinguishes an sdk session from an interactive one", async () => {
    const path = await writeTranscript({
      id: ID,
      cwd: CWD,
      records: conversation({ id: ID, cwd: CWD, prompt: "headless", entrypoint: "sdk-cli" }),
    });
    expect((await parse(path)).origin).toBe("sdk-cli");
  });
});
