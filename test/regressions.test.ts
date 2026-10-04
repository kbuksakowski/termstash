import { describe, expect, it } from "vitest";
import { extractPromptText } from "../src/adapters/claude/records.js";
import { readMetadata, updateSession, writeMetadata } from "../src/core/metadata/store.js";
import { claudeRoot } from "../src/adapters/claude/paths.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { metadataFile } from "../src/core/paths.js";

/**
 * Each of these was introduced by a security fix earlier the same day. They are
 * kept together because the lesson is shared: a fix is new code, and the person
 * writing it has just formed a model of the bug that is usually too narrow.
 */
function home(): string {
  const value = process.env["TERMSTASH_HOME"];
  if (value === undefined) throw new Error("TERMSTASH_HOME not set");
  return value;
}

describe("a scan cap must not turn captured output into a title", () => {
  it("drops an unclosed span to the end rather than keeping it", () => {
    // The 64 KB cap was applied before span removal, so a </local-command-stdout>
    // past the cap left the shell output in place - and an AWS key appeared in
    // the default list view.
    const secret = "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI";
    const prompt =
      "<command-message>run</command-message><command-name>/deploy</command-name>" +
      `<local-command-stdout>${secret} ${"o".repeat(72_000)}</local-command-stdout>`;

    const title = extractPromptText(prompt);
    expect(title).toBe("/deploy");
    expect(title).not.toContain("AWS_SECRET");
  });

  it("still reads an ordinary prompt", () => {
    expect(extractPromptText("fix the webhook retries")).toBe("fix the webhook retries");
  });
});

describe("metadata entries this tool cannot read are not its to delete", () => {
  it("keeps a malformed entry verbatim across an unrelated write", async () => {
    const other = "22222222-2222-4333-8444-555555555555";
    const malformed = { sessionId: other, pinned: "yes", title: "MY TITLE", notes: "a note" };
    await writeFile(
      metadataFile(home()),
      JSON.stringify({ schemaVersion: 1, sessions: { [other]: malformed } }),
    );

    await updateSession(home(), "11111111-1111-4111-8111-111111111111", (current) => ({
      ...current,
      title: "new",
    }));

    const raw = JSON.parse(
      await (await import("node:fs/promises")).readFile(metadataFile(home()), "utf8"),
    ) as { sessions: Record<string, unknown> };
    expect(raw.sessions[other]).toEqual(malformed);
  });

  it("still reports it as rejected rather than pretending it is fine", async () => {
    const other = "33333333-2222-4333-8444-555555555555";
    await writeFile(
      metadataFile(home()),
      JSON.stringify({ schemaVersion: 1, sessions: { [other]: { pinned: 7 } } }),
    );

    const metadata = await readMetadata(home());
    expect(Object.keys(metadata.rejected ?? {})).toEqual([other]);
    expect(metadata.sessions[other]).toBeUndefined();
  });
});

describe("an environment override is used as given", () => {
  it("does not trim a directory whose name ends in a space", () => {
    // Trimming pointed at a different path, so TermStash created a second
    // config root and wrote a transcript carrying secrets into it.
    expect(claudeRoot({ CLAUDE_CONFIG_DIR: "/tmp/padded " })).toBe("/tmp/padded ");
  });

  it("refuses an empty one instead of falling back to the real home", () => {
    expect(() => claudeRoot({ CLAUDE_CONFIG_DIR: "   " })).toThrow(/empty value/);
  });
});
