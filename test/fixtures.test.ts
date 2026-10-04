import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseTranscript } from "../src/adapters/claude/parse.js";

/**
 * Parse real transcripts recorded from a specific Claude Code build.
 *
 * The format is internal and documented as subject to change on any release
 * (spike R1), so these are the regression net for a version bump: record a
 * fixture, run the suite, then extend the supported range (PRD v0.2 §48.6).
 */
const DIR = fileURLToPath(new URL("./fixtures/claude-2.1.269/", import.meta.url));

async function parse(name: string) {
  const path = `${DIR}${name}`;
  const { size } = await stat(path);
  return parseTranscript(path, size);
}

describe("Claude Code 2.1.269 transcripts", () => {
  it("reads the metadata list depends on", async () => {
    const parsed = await parse("ai-title.jsonl");
    expect(parsed.cwd).toBe("/fixture/sorting-project");
    expect(parsed.versions).toEqual(["2.1.269"]);
    expect(parsed.createdAt).toBeInstanceOf(Date);
    expect(parsed.lastMessageAt).toBeInstanceOf(Date);
  });

  it("picks up a generated title", async () => {
    const parsed = await parse("ai-title.jsonl");
    expect(parsed.title).toBe("Sorting algorithms");
    expect(parsed.titleSource).toBe("ai");
  });

  it("prefers a name set with -n over anything generated", async () => {
    const parsed = await parse("custom-title.jsonl");
    expect(parsed.title).toBe("fixture-named-session");
    expect(parsed.titleSource).toBe("custom");
  });

  it("recognises a headless session as sdk-cli", async () => {
    expect((await parse("ai-title.jsonl")).origin).toBe("sdk-cli");
  });

  it("parses cleanly, with no warnings and no unknown record types", async () => {
    // The point of the fixture: if 2.1.269 had moved the format, this fails.
    for (const name of ["ai-title.jsonl", "custom-title.jsonl"]) {
      const parsed = await parse(name);
      expect(parsed.warnings).toEqual([]);
      expect(parsed.unknownRecordTypes).toEqual([]);
    }
  });
});

/**
 * Recorded 2026-10-04 from 2.1.289, the build that moved
 * `VERIFIED_CLAUDE_VERSION` forward. Recorded, not written: a hand-made
 * fixture shows what we think the format is, which is the one thing a fixture
 * exists to check.
 *
 * It caught a difference on the first run. 2.1.269 gave a headless session an
 * `ai-title` record; 2.1.289 gives it none, so the title falls back to the
 * first prompt. The parser already handled that - but no fixture had ever
 * exercised it, which is why this one is named for the path it takes.
 */
const DIR_289 = fileURLToPath(new URL("./fixtures/claude-2.1.289/", import.meta.url));

async function parse289(name: string) {
  const path = `${DIR_289}${name}`;
  const { size } = await stat(path);
  return parseTranscript(path, size);
}

describe("Claude Code 2.1.289 transcripts", () => {
  it("reads the metadata list depends on", async () => {
    const parsed = await parse289("first-prompt.jsonl");
    expect(parsed.cwd).toBe("/fixture/sorting-project");
    expect(parsed.versions).toEqual(["2.1.289"]);
    expect(parsed.createdAt).toBeInstanceOf(Date);
    expect(parsed.lastMessageAt).toBeInstanceOf(Date);
  });

  it("titles a headless session from its first prompt, because 2.1.289 writes no ai-title", async () => {
    const parsed = await parse289("first-prompt.jsonl");
    expect(parsed.titleSource).toBe("first-prompt");
    expect(parsed.title).toContain("bubble sort");
  });

  it("prefers a name set with -n over anything generated", async () => {
    const parsed = await parse289("custom-title.jsonl");
    expect(parsed.title).toBe("fixture-named-session");
    expect(parsed.titleSource).toBe("custom");
  });

  it("recognises a headless session as sdk-cli", async () => {
    expect((await parse289("first-prompt.jsonl")).origin).toBe("sdk-cli");
  });

  it("parses cleanly, with no warnings and no unknown record types", async () => {
    // `cost-state` appears here and in neither 2.1.269 fixture.
    for (const name of ["first-prompt.jsonl", "custom-title.jsonl"]) {
      const parsed = await parse289(name);
      expect(parsed.warnings).toEqual([]);
      expect(parsed.unknownRecordTypes).toEqual([]);
    }
  });
});
