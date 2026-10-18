import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The Claude Code plugin ships from this repository, beside the npm package.
 * Claude Code only offers an update when the plugin version changes, so it
 * moves with the package version.
 */

const json = (path: string) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));

describe("plugin", () => {
  it("has the package version", () => {
    expect(json(".claude-plugin/plugin.json").version).toBe(json("package.json").version);
  });

  it("is listed by its own marketplace from the repository root", () => {
    const [entry] = json(".claude-plugin/marketplace.json").plugins;
    expect(entry).toMatchObject({ name: "termstash", source: "./" });
  });

  it("names its skill as the README does", () => {
    const skill = readFileSync(new URL("../skills/find-session/SKILL.md", import.meta.url), "utf8");
    expect(skill).toMatch(/^---\nname: find-session\n/);
  });
});
