import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeRoot } from "../src/adapters/claude/paths.js";

describe("test isolation", () => {
  it("never resolves to the developer's real Claude config root", async () => {
    const real = resolve(join(homedir(), ".claude"));
    const resolved = resolve(claudeRoot());
    expect(resolved).not.toBe(real);
    expect(resolved.startsWith(`${real}/`)).toBe(false);
  });

  it("honours CLAUDE_CONFIG_DIR over the home directory", () => {
    expect(claudeRoot({ CLAUDE_CONFIG_DIR: "/tmp/elsewhere" })).toBe("/tmp/elsewhere");
    // Returned unmodified. Trimming looked harmless and was not: a directory
    // whose name ends in a space is legal, so trimming pointed at a different
    // path and TermStash created a second config root without saying so.
    expect(claudeRoot({ CLAUDE_CONFIG_DIR: "/tmp/padded " })).toBe("/tmp/padded ");
  });

  it("refuses an empty override instead of quietly using the real home", () => {
    // This test previously asserted the opposite. Falling back on an empty
    // value is how a harness with an unset variable ends up reading and
    // writing the developer's live sessions while believing it is sandboxed —
    // the single thing every other guard in this suite exists to prevent.
    for (const value of ["", "   "]) {
      expect(() => claudeRoot({ CLAUDE_CONFIG_DIR: value })).toThrow(/empty value/);
    }
  });

  it("falls back to the home directory only when the variable is absent", () => {
    expect(claudeRoot({})).toBe(join(homedir(), ".claude"));
  });
});
