import { describe, expect, it, vi } from "vitest";
import { searchTranscript } from "../src/adapters/claude/search.js";
import { normalizeQuery, rankMatches, snippet } from "../src/core/search/index.js";
import type { SessionMatch } from "../src/core/search/index.js";
import type { Session } from "../src/core/session/types.js";
import { parseArgs } from "../src/cli/args.js";
import { searchCommand } from "../src/cli/search.js";
import { conversation, writeTranscript } from "./helpers/sandbox.js";

const ID = "aaaaaaaa-0000-4000-8000-000000000001";
const CWD = "/tmp/backend_api";
const NOW = new Date("2026-09-12T12:00:00.000Z");

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: ID,
    agent: "claude-code",
    agentVersions: ["2.1.263"],
    sourcePath: "/nonexistent/never-opened.jsonl",
    projectDirName: "-tmp-backend-api",
    projectPath: CWD,
    projectName: "backend_api",
    projectPathExists: true,
    updatedAt: NOW,
    sizeBytes: 10,
    origin: "interactive",
    isLive: false,
    hasSubagents: false,
    hasToolResults: false,
    retention: { status: "ok", ageDays: 0 },
    parseWarnings: [],
    ...overrides,
  };
}

describe("snippet", () => {
  it("returns a window around the hit", () => {
    const text = `${"a".repeat(200)} stripe ${"b".repeat(200)}`;
    const out = snippet(text, "stripe");
    expect(out).toContain("stripe");
    expect(out?.length).toBeLessThanOrEqual(122);
    expect(out?.startsWith("…")).toBe(true);
  });

  it("collapses whitespace so a snippet stays one line", () => {
    expect(snippet("fix   the\n\nstripe\thook", "stripe")).toBe("fix the stripe hook");
  });

  it("returns undefined when the needle is absent or the text is blank", () => {
    expect(snippet("nothing here", "stripe")).toBeUndefined();
    expect(snippet("   ", "stripe")).toBeUndefined();
  });
});

describe("rankMatches", () => {
  it("puts stronger fields first and breaks ties by recency", () => {
    const older = new Date(NOW.getTime() - 86_400_000);
    const matches: SessionMatch[] = [
      { session: session({ id: "t1" }), fields: ["transcript"], hits: 9 },
      { session: session({ id: "p1" }), fields: ["project"], hits: 1 },
      { session: session({ id: "n1" }), fields: ["title"], hits: 1 },
      { session: session({ id: "n2", updatedAt: older }), fields: ["title"], hits: 1 },
    ];
    expect(rankMatches(matches).map((m) => m.session.id)).toEqual(["n1", "n2", "p1", "t1"]);
  });
});

describe("searchTranscript", () => {
  it("matches a human prompt and reports it as such", async () => {
    const path = await writeTranscript({
      id: ID,
      cwd: CWD,
      records: conversation({ id: ID, cwd: CWD, prompt: "fix the stripe webhook" }),
    });
    const hit = await searchTranscript(path, "stripe");
    expect(hit?.field).toBe("prompt");
    expect(hit?.snippet).toContain("stripe");
  });

  it("matches assistant prose as a weaker transcript hit", async () => {
    const records = conversation({ id: ID, cwd: CWD, prompt: "hello" });
    records.push({
      type: "assistant", sessionId: ID, cwd: CWD, timestamp: "2026-09-01T10:01:00.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "the stripe hook is fine" }] },
    });
    const path = await writeTranscript({ id: ID, cwd: CWD, records });
    expect((await searchTranscript(path, "stripe"))?.field).toBe("transcript");
  });

  it("prefers a human prompt over assistant prose", async () => {
    const records = conversation({ id: ID, cwd: CWD, prompt: "hello" });
    records.push({
      type: "assistant", sessionId: ID, cwd: CWD, timestamp: "2026-09-01T10:01:00.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "stripe first" }] },
    });
    records.push({
      type: "user", sessionId: ID, cwd: CWD, timestamp: "2026-09-01T10:02:00.000Z",
      message: { role: "user", content: "now about stripe billing" },
    });
    const path = await writeTranscript({ id: ID, cwd: CWD, records });
    const hit = await searchTranscript(path, "stripe");
    expect(hit?.field).toBe("prompt");
    expect(hit?.snippet).toContain("billing");
  });

  it("ignores tool results, attachments and snapshots", async () => {
    // These routinely contain the query by coincidence. Matching them would
    // surface blobs instead of conversations.
    const records = conversation({ id: ID, cwd: CWD, prompt: "hello" });
    records.push({
      type: "user", sessionId: ID, cwd: CWD, toolUseResult: { stdout: "stripe stripe stripe" },
      timestamp: "2026-09-01T10:01:00.000Z",
      message: { role: "user", content: "stripe in a tool result" },
    });
    records.push({ type: "attachment", attachment: { text: "stripe" }, sessionId: ID });
    records.push({
      type: "file-history-snapshot", messageId: "m1",
      snapshot: { trackedFileBackups: { a: "stripe" } },
    });
    const path = await writeTranscript({ id: ID, cwd: CWD, records });
    expect(await searchTranscript(path, "stripe")).toBeUndefined();
  });

  it("ignores subagent turns", async () => {
    const records = conversation({ id: ID, cwd: CWD, prompt: "hello" });
    records.push({
      type: "user", sessionId: ID, cwd: CWD, isSidechain: true,
      timestamp: "2026-09-01T10:01:00.000Z",
      message: { role: "user", content: "stripe from a subagent" },
    });
    const path = await writeTranscript({ id: ID, cwd: CWD, records });
    expect(await searchTranscript(path, "stripe")).toBeUndefined();
  });

  it("counts hits and stops at the cap", async () => {
    const records = conversation({ id: ID, cwd: CWD, prompt: "stripe 0" });
    for (let i = 1; i < 20; i += 1) {
      records.push({
        type: "user", sessionId: ID, cwd: CWD, timestamp: "2026-09-01T10:01:00.000Z",
        message: { role: "user", content: `stripe ${i}` },
      });
    }
    const path = await writeTranscript({ id: ID, cwd: CWD, records });
    expect((await searchTranscript(path, "stripe", { maxHits: 5 }))?.hits).toBe(5);
  });

  it("is case-insensitive", async () => {
    const path = await writeTranscript({
      id: ID,
      cwd: CWD,
      records: conversation({ id: ID, cwd: CWD, prompt: "fix the STRIPE hook" }),
    });
    expect(await searchTranscript(path, "stripe")).toBeDefined();
  });
});

describe("searchCommand", () => {
  const discovery = (sessions: Session[]) => async () => ({
    sessions,
    artifacts: [],
    unreadable: [],
  });

  it("refuses an empty query", async () => {
    const errors: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((c) => (errors.push(String(c)), true));
    const code = await searchCommand(parseArgs(["search"]), { discover: discovery([]), now: NOW });
    expect(code).toBe(1);
    expect(errors.join("")).toMatch(/needs something to look for/);
  });

  it("matches a title without opening the transcript", async () => {
    // sourcePath is deliberately nonexistent: a title hit must not touch disk.
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((c) => (out.push(String(c)), true));
    const code = await searchCommand(parseArgs(["search", "stripe", "--json"]), {
      discover: discovery([session({ title: "Stripe webhook" })]),
      now: NOW,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join(""));
    expect(parsed.sessions).toHaveLength(1);
    expect(parsed.sessions[0].fields).toEqual(["title"]);
    expect(parsed.historical).toEqual([]);
  });

  it("says what it searched, so silence is not read as proof", async () => {
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((c) => (out.push(String(c)), true));
    await searchCommand(parseArgs(["search", "nothingmatchesthis"]), {
      discover: discovery([session({ title: "Stripe webhook" })]),
      now: NOW,
    });
    const text = out.join("");
    expect(text).toMatch(/No matches/);
    // Since Phase 7 the prompt history is searched too, so "no matches" now
    // covers sessions Claude already deleted rather than silently excluding them.
    expect(text).toMatch(/Claude's prompt history/);
  });
});

describe("robustness", () => {
  it("survives a transcript that vanished between discovery and search", async () => {
    // Claude's sweep can delete a file at any moment. One missing transcript
    // must not take the whole search down.
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((c) => (out.push(String(c)), true));
    const code = await searchCommand(parseArgs(["search", "stripe"]), {
      discover: async () => ({
        sessions: [session({ sourcePath: "/gone/never-existed.jsonl" })],
        artifacts: [],
        unreadable: [],
      }),
      now: NOW,
    });
    expect(code).toBe(0);
    expect(out.join("")).toMatch(/could not be read and were skipped/);
  });
});

describe("query characters", () => {
  it("treats regex metacharacters as literal text", async () => {
    // The fast gate is a regex, so an unescaped query would either throw or
    // match the wrong thing. "a.c" must not match "abc".
    const path = await writeTranscript({
      id: ID,
      cwd: CWD,
      records: conversation({ id: ID, cwd: CWD, prompt: "the value is a.c not abc" }),
    });
    expect(await searchTranscript(path, "a.c")).toBeDefined();

    const other = await writeTranscript({
      id: "bbbbbbbb-0000-4000-8000-000000000002",
      cwd: CWD,
      records: conversation({ id: ID, cwd: CWD, prompt: "only abc here" }),
    });
    expect(await searchTranscript(other, "a.c")).toBeUndefined();
  });

  it("does not crash on an unbalanced bracket", async () => {
    const path = await writeTranscript({
      id: ID,
      cwd: CWD,
      records: conversation({ id: ID, cwd: CWD, prompt: "array[0] indexing" }),
    });
    expect(await searchTranscript(path, "array[0]")).toBeDefined();
  });
});

describe("historical results", () => {
  it("surfaces a session Claude already deleted, marked not resumable", async () => {
    const { writeHistory } = await import("./helpers/sandbox.js");
    await writeHistory([
      {
        display: "debug the stripe signature check",
        project: "/tmp/payments",
        sessionId: "cccccccc-0000-4000-8000-000000000003",
        timestamp: Date.parse("2026-06-01T10:00:00.000Z"),
      },
    ]);

    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((c) => (out.push(String(c)), true));
    await searchCommand(parseArgs(["search", "stripe"]), {
      discover: async () => ({ sessions: [], artifacts: [], unreadable: [] }),
      now: NOW,
    });

    const text = out.join("");
    expect(text).toMatch(/HISTORICAL — TRANSCRIPT GONE/);
    expect(text).toMatch(/not resumable/);
    expect(text).toMatch(/payments/);
  });

  it("does not repeat a session that is still live", async () => {
    const { writeHistory } = await import("./helpers/sandbox.js");
    await writeHistory([
      { display: "stripe work", project: "/tmp/backend_api", sessionId: ID, timestamp: Date.now() },
    ]);

    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((c) => (out.push(String(c)), true));
    await searchCommand(parseArgs(["search", "stripe", "--json"]), {
      discover: async () => ({
        sessions: [session({ title: "Stripe webhook" })],
        artifacts: [],
        unreadable: [],
      }),
      now: NOW,
    });

    const parsed = JSON.parse(out.join(""));
    expect(parsed.sessions).toHaveLength(1);
    expect(parsed.historical).toEqual([]);
  });
});

describe("compacted sessions", () => {
  it("searches turns from before a /compact, not just after it", async () => {
    // Compaction shrinks what is sent to the model; it does not remove anything
    // from the transcript. Verified against a real session that had been
    // compacted twice, dropping 1.5M tokens of context while keeping 77 user
    // turns from before the first compaction on disk and searchable.
    const before = {
      type: "user", sessionId: ID, cwd: CWD, timestamp: "2026-09-01T09:00:00.000Z",
      message: { role: "user", content: "check whether the WAF is already deployed" },
    };
    const boundary = {
      type: "system", sessionId: ID, cwd: CWD, timestamp: "2026-09-01T10:00:00.000Z",
      compactMetadata: { trigger: "manual", preTokens: 849270, postTokens: 18463 },
    };
    const summary = {
      type: "user", sessionId: ID, cwd: CWD, isCompactSummary: true,
      timestamp: "2026-09-01T10:00:01.000Z",
      message: { role: "user", content: "This session is being continued from a previous conversation…" },
    };
    const after = {
      type: "user", sessionId: ID, cwd: CWD, timestamp: "2026-09-01T11:00:00.000Z",
      message: { role: "user", content: "now update the terraform module" },
    };

    const path = await writeTranscript({
      id: ID,
      cwd: CWD,
      records: [...conversation({ id: ID, cwd: CWD, prompt: "start" }), before, boundary, summary, after],
    });

    expect((await searchTranscript(path, "WAF is already deployed"))?.field).toBe("prompt");
    expect((await searchTranscript(path, "terraform module"))?.field).toBe("prompt");
  });
});

describe("query normalisation", () => {
  it("matches regardless of the case the caller passes", async () => {
    const path = await writeTranscript({
      id: ID,
      cwd: CWD,
      records: conversation({ id: ID, cwd: CWD, prompt: "fix the Stripe webhook" }),
    });
    for (const query of ["stripe", "STRIPE", "Stripe", "StRiPe"]) {
      expect(await searchTranscript(path, query)).toBeDefined();
    }
  });
});
