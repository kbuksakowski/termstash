import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The Claude Code plugin ships from this repository, beside the npm package.
 * It lives in plugin/ because Claude Code copies a plugin's directory on
 * install and runs `npm install` when it finds a package.json and a lockfile
 * there: from the repository root that is every devDependency, 80 MB for one
 * SKILL.md. Claude Code only offers an update when the plugin version
 * changes, so it moves with the package version.
 */

const json = (path: string) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));

describe("plugin", () => {
  it("has the package version", () => {
    expect(json("plugin/.claude-plugin/plugin.json").version).toBe(json("package.json").version);
  });

  it("is listed by the marketplace at the repository root", () => {
    const [entry] = json(".claude-plugin/marketplace.json").plugins;
    expect(entry).toMatchObject({ name: "termstash", source: "./plugin" });
  });

  it("has no package.json for Claude Code to install", () => {
    expect(() => json("plugin/package.json")).toThrow();
  });

  it("names its skill as the README does", () => {
    const skill = readFileSync(new URL("../plugin/skills/find-session/SKILL.md", import.meta.url), "utf8");
    expect(skill).toMatch(/^---\nname: find-session\n/);
  });
});
