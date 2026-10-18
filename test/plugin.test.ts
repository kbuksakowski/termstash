import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The Claude Code plugin ships from this repository, beside the npm package.
 * It lives in plugin/ because Claude Code copies a plugin's directory on
 * install and runs `npm install` when it finds a package.json and a lockfile
 * there: from the repository root that is every devDependency, 80 MB for one
 * SKILL.md. Claude Code only offers an update when the plugin version
 * changes, so a CLI release moves it too; it can also move on its own, for a
 * change to the plugin alone.
 */

const json = (path: string) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));

describe("plugin", () => {
  it("is never behind the package version", () => {
    const parts = (v: string) => v.split(".").map(Number);
    const [plugin, pkg] = [parts(json("plugin/.claude-plugin/plugin.json").version), parts(json("package.json").version)];
    const cmp = plugin.map((n, i) => n - (pkg[i] ?? 0)).find((d) => d !== 0) ?? 0;
    expect(cmp).toBeGreaterThanOrEqual(0);
  });

  it("runs npx pinned to the released package version", () => {
    // The plugin directory refuses an unpinned launcher, and @latest made the
    // skill depend on whatever npm served that minute.
    const skill = readFileSync(new URL("../plugin/skills/find-session/SKILL.md", import.meta.url), "utf8");
    const readme = readFileSync(new URL("../plugin/README.md", import.meta.url), "utf8");
    const pinned = [...`${skill}\n${readme}`.matchAll(/npx termstash@([^\s`)]+)/g)].map((m) => m[1]);
    expect(pinned.length).toBeGreaterThan(0);
    expect(new Set(pinned)).toEqual(new Set([json("package.json").version]));
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
