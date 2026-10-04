import { describe, expect, it } from "vitest";
import { extractPromptText, isHumanPrompt, parseLine } from "../src/adapters/claude/records.js";

describe("parseLine", () => {
  it("returns null for blank and malformed lines instead of throwing", () => {
    expect(parseLine("")).toBeNull();
    expect(parseLine("   ")).toBeNull();
    expect(parseLine("{not json")).toBeNull();
    expect(parseLine("[1,2]")).toBeNull();
    expect(parseLine("null")).toBeNull();
  });

  it("parses an object line", () => {
    expect(parseLine('{"type":"user"}')).toEqual({ type: "user" });
  });
});

describe("isHumanPrompt", () => {
  it("accepts a plain user turn", () => {
    expect(isHumanPrompt({ type: "user", message: {} })).toBe(true);
  });

  it("rejects the records that would pollute titles and search", () => {
    expect(isHumanPrompt({ type: "assistant" })).toBe(false);
    expect(isHumanPrompt({ type: "user", isMeta: true })).toBe(false);
    expect(isHumanPrompt({ type: "user", isSidechain: true })).toBe(false);
    expect(isHumanPrompt({ type: "user", toolUseResult: { ok: 1 } })).toBe(false);
  });
});

describe("extractPromptText", () => {
  it("reads a plain string", () => {
    expect(extractPromptText("fix the webhook")).toBe("fix the webhook");
  });

  it("reads text blocks out of an array", () => {
    const content = [
      { type: "text", text: "fix the" },
      { type: "image", source: {} },
      { type: "text", text: "webhook" },
    ];
    expect(extractPromptText(content)).toBe("fix the webhook");
  });

  it("keeps a slash command as the whole prompt", () => {
    const content = "<command-message>commit</command-message><command-name>/commit</command-name>";
    expect(extractPromptText(content)).toBe("/commit");
  });

  it("drops local command output", () => {
    const content = "check this <local-command-stdout>tons of noise</local-command-stdout>";
    expect(extractPromptText(content)).toBe("check this");
  });

  it("drops paste placeholders", () => {
    expect(extractPromptText("look [Pasted text #1 +34 lines] here")).toBe("look here");
  });

  it("returns undefined when nothing readable is left", () => {
    expect(extractPromptText("<local-command-stdout>x</local-command-stdout>")).toBeUndefined();
    expect(extractPromptText(42)).toBeUndefined();
    expect(extractPromptText(undefined)).toBeUndefined();
  });
});
