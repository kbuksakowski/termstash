import { stat } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { Discovery } from "../src/adapters/claude/discover.js";
import { readMetadata } from "../src/core/metadata/store.js";
import type { Session } from "../src/core/session/types.js";
import { parseArgs } from "../src/cli/args.js";
import { listCommand } from "../src/cli/list.js";
import { MAX_TITLE_LENGTH, renameCommand } from "../src/cli/rename.js";
import { searchCommand } from "../src/cli/search.js";
import { conversation, writeTranscript } from "./helpers/sandbox.js";

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "aaaaaaaa-0000-4000-8000-000000000002";
const CWD = "/tmp/backend_api";
const NOW = new Date("2026-09-13T12:00:00.000Z");

function home(): string {
  const v = process.env["TERMSTASH_HOME"];
  if (v === undefined) throw new Error("TERMSTASH_HOME not set");
  return v;
}

async function seed(id: string, prompt: string, title?: string): Promise<Session> {
  const path = await writeTranscript({
    id,
    cwd: CWD,
    records: conversation({
      id,
      cwd: CWD,
      prompt,
      ...(title !== undefined ? { aiTitle: title } : {}),
    }),
  });
  const info = await stat(path);
  return {
    id,
    agent: "claude-code",
    agentVersions: ["2.1.269"],
    sourcePath: path,
    projectDirName: "-tmp-backend-api",
    projectPath: CWD,
    projectName: "backend_api",
    projectPathExists: true,
    updatedAt: info.mtime,
    sizeBytes: info.size,
    origin: "interactive",
    isLive: false,
    hasSubagents: false,
    hasToolResults: false,
    retention: { status: "ok", ageDays: 0 },
    parseWarnings: [],
    ...(title !== undefined ? { title, titleSource: "ai" as const } : {}),
  };
}

const deps = (sessions: Session[]) => ({
  discover: async (): Promise<Discovery> => ({ sessions, artifacts: [], unreadable: [] }),
  root: home(),
  now: NOW,
});

function capture(): string[] {
  const out: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((c) => (out.push(String(c)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((c) => (out.push(String(c)), true));
  return out;
}

describe("renameCommand", () => {
  it("stores the title in TermStash's metadata, not the transcript", async () => {
    const session = await seed(A, "/commit", "/commit");
    const before = await import("node:fs/promises").then((fs) =>
      fs.readFile(session.sourcePath, "utf8"),
    );
    capture();

    expect(await renameCommand(parseArgs(["rename", A, "Stripe webhook"]), deps([session]))).toBe(0);
    expect((await readMetadata(home())).sessions[A]?.title).toBe("Stripe webhook");

    // The Claude-owned file is untouched. Section 5.3.
    const after = await import("node:fs/promises").then((fs) =>
      fs.readFile(session.sourcePath, "utf8"),
    );
    expect(after).toBe(before);
  });

  it("says out loud that Claude's own picker will not show it", async () => {
    const session = await seed(A, "hello");
    const out = capture();
    await renameCommand(parseArgs(["rename", A, "My title"]), deps([session]));
    expect(out.join("")).toMatch(/Claude's session picker still shows its/);
  });

  it("joins a multi-word title given without quotes", async () => {
    const session = await seed(A, "hello");
    capture();
    await renameCommand(parseArgs(["rename", A, "Stripe", "webhook", "retry"]), deps([session]));
    expect((await readMetadata(home())).sessions[A]?.title).toBe("Stripe webhook retry");
  });

  it("refuses an empty title rather than storing one", async () => {
    const session = await seed(A, "hello");
    const out = capture();
    expect(await renameCommand(parseArgs(["rename", A, "   "]), deps([session]))).toBe(1);
    expect(out.join("")).toMatch(/needs a title/);
    expect((await readMetadata(home())).sessions[A]).toBeUndefined();
  });

  it("refuses a title that would not fit a terminal", async () => {
    const session = await seed(A, "hello");
    const out = capture();
    const code = await renameCommand(
      parseArgs(["rename", A, "x".repeat(MAX_TITLE_LENGTH + 1)]),
      deps([session]),
    );
    expect(code).toBe(1);
    expect(out.join("")).toMatch(/the limit is/);
  });

  it("refuses an ambiguous id without renaming anything", async () => {
    const sessions = [await seed(A, "one"), await seed(B, "two")];
    const out = capture();
    expect(await renameCommand(parseArgs(["rename", "aaaaaa", "x"]), deps(sessions))).toBe(1);
    expect(out.join("")).toMatch(/matches 2 sessions/);
    expect(Object.keys((await readMetadata(home())).sessions)).toHaveLength(0);
  });

  it("clears a title and falls back to Claude's", async () => {
    const session = await seed(A, "hello", "Claude's own title");
    capture();
    await renameCommand(parseArgs(["rename", A, "Mine"]), deps([session]));

    const out = capture();
    expect(await renameCommand(parseArgs(["rename", A, "--clear"]), deps([session]))).toBe(0);
    expect(out.join("")).toMatch(/Claude's own title/);
    expect((await readMetadata(home())).sessions[A]?.title).toBeUndefined();
  });

  it("is a no-op when clearing a title that was never set", async () => {
    const session = await seed(A, "hello");
    const out = capture();
    expect(await renameCommand(parseArgs(["rename", A, "--clear"]), deps([session]))).toBe(0);
    expect(out.join("")).toMatch(/no TermStash title/);
  });

  it("keeps pin state when renaming", async () => {
    const session = await seed(A, "hello");
    const { updateSession } = await import("../src/core/metadata/store.js");
    await updateSession(home(), A, (c) => ({ ...c, pinned: true }));
    capture();
    await renameCommand(parseArgs(["rename", A, "Important"]), deps([session]));

    const entry = (await readMetadata(home())).sessions[A];
    expect(entry?.pinned).toBe(true);
    expect(entry?.title).toBe("Important");
  });
});

describe("a renamed session in list and search", () => {
  it("shows the TermStash title instead of Claude's", async () => {
    const session = await seed(A, "/commit", "/commit");
    capture();
    await renameCommand(parseArgs(["rename", A, "Stripe webhook"]), deps([session]));

    const out = capture();
    await listCommand(parseArgs(["list"]), NOW);
    expect(out.join("")).toContain("Stripe webhook");
    expect(out.join("")).not.toContain("/commit");
  });

  it("is findable by the title the user gave it", async () => {
    // The point of rename: 99 sessions called /commit are unsearchable.
    const session = await seed(A, "/commit", "/commit");
    capture();
    await renameCommand(parseArgs(["rename", A, "Stripe webhook"]), deps([session]));

    const out = capture();
    await searchCommand(parseArgs(["search", "stripe", "--json"]), deps([session]));
    const parsed = JSON.parse(out.join("").slice(out.join("").indexOf("{")));
    expect(parsed.sessions).toHaveLength(1);
    expect(parsed.sessions[0].title).toBe("Stripe webhook");
    expect(parsed.sessions[0].fields).toContain("title");
  });
});

describe('the "was:" line', () => {
  it("reports the TermStash title it is replacing, not Claude's", async () => {
    // A second rename used to report Claude's original title as "was", which
    // read as though the previous rename had been undone.
    const session = await seed(A, "hello", "Claude's own title");
    capture();
    await renameCommand(parseArgs(["rename", A, "First"]), deps([session]));

    const out = capture();
    await renameCommand(parseArgs(["rename", A, "Second"]), deps([session]));
    const text = out.join("");

    expect(text).toContain("was: First");
    expect(text).toContain("now: Second");
    expect(text).not.toContain("Claude's own title");
  });

  it("reports Claude's title on the first rename, since that is what it replaces", async () => {
    const session = await seed(A, "hello", "Claude's own title");
    const out = capture();
    await renameCommand(parseArgs(["rename", A, "Mine"]), deps([session]));
    expect(out.join("")).toContain("was: Claude's own title");
  });

  it("says nothing about a previous title when renaming to the same thing", async () => {
    const session = await seed(A, "hello", "Same");
    const out = capture();
    await renameCommand(parseArgs(["rename", A, "Same"]), deps([session]));
    expect(out.join("")).not.toContain("was:");
  });
});
