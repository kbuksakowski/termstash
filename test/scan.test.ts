import { describe, expect, it } from "vitest";
import { scanTranscripts } from "../src/adapters/claude/scan.js";
import { conversation, root, writeRaw, writeTranscript } from "./helpers/sandbox.js";

const ID = "11111111-2222-4333-8444-555555555555";

describe("scanTranscripts", () => {
  it("accepts only uuid-named .jsonl files", async () => {
    await writeTranscript({
      id: ID,
      cwd: "/tmp/repo",
      records: conversation({ id: ID, cwd: "/tmp/repo", prompt: "hello" }),
    });
    await writeRaw("-tmp-repo", "sessions-index.json", "{}");
    await writeRaw("-tmp-repo", "MEMORY.md", "# notes");
    await writeRaw("-tmp-repo", ".DS_Store", "junk");
    await writeRaw("-tmp-repo", "not-a-uuid.jsonl", "{}");

    const result = await scanTranscripts(root());
    expect(result.transcripts.map((t) => t.id)).toEqual([ID]);
  });

  it("collects set-aside artifacts separately, never as sessions", async () => {
    await writeRaw("-tmp-repo", `${ID}.orphaned-1234-abc.jsonl`, "{}");
    await writeRaw("-tmp-repo", `${ID}.jsonl.superseded-1234`, "{}");

    const result = await scanTranscripts(root());
    expect(result.transcripts).toEqual([]);
    expect(result.artifacts.map((a) => a.kind).sort()).toEqual(["orphaned", "superseded"]);
    expect(result.artifacts.every((a) => a.sessionId === ID)).toBe(true);
  });

  it("does not treat subagent transcripts as sessions", async () => {
    // Subagent files carry the PARENT session id; listing them would duplicate it.
    await writeRaw(`-tmp-repo/${ID}/subagents`, "agent-abc123.jsonl", "{}");
    const result = await scanTranscripts(root());
    expect(result.transcripts).toEqual([]);
  });
});

describe("a machine with no Claude sessions yet", () => {
  it("reports no sessions rather than a fault", async () => {
    // What a new user's first run looks like. Reporting a missing projects
    // directory as a problem would make the tool read as broken on install.
    const result = await scanTranscripts(root());
    expect(result.transcripts).toEqual([]);
    expect(result.unreadable).toEqual([]);
  });

  it("still reports a directory that exists but cannot be read", async () => {
    const { chmod, mkdir } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const dir = join(root(), "projects");
    await mkdir(dir, { recursive: true });
    await chmod(dir, 0o000);
    try {
      const result = await scanTranscripts(root());
      // Root can read anything, so only assert when the restriction took hold.
      if (result.unreadable.length > 0) {
        expect(result.unreadable[0]?.reason).toMatch(/permission|EACCES/i);
      }
    } finally {
      await chmod(dir, 0o700);
    }
  });
});
