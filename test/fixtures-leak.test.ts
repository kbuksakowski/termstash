import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * PRD v0.2 section 48.2. Sanitisation is a verified step, not a habit.
 *
 * This repository is intended to be public. A transcript fixture that leaked a
 * real home path, account identifier or token would not be retractable once
 * pushed, so the check runs in CI and blocks the merge.
 */
const FIXTURES = new URL("./fixtures/", import.meta.url).pathname;

const FORBIDDEN: { name: string; pattern: RegExp }[] = [
  { name: "real home directory", pattern: /\/(Users|home)\/(?!fixture\b)[A-Za-z0-9._-]+\// },
  // Claude names a project directory by replacing every non-alphanumeric with
  // a dash, so a real home path reaches a transcript as `-Users-someone-...`
  // and the rule above can never match it. Two fixtures shipped a real path
  // past that gap before this line existed.
  { name: "mangled home directory", pattern: /-(Users|home)-(?!fixture\b)[A-Za-z0-9]+-/ },
  { name: "Windows profile path", pattern: /[A-Za-z]:\\\\Users\\\\/ },
  // Claude Code's own system prompt is not ours to redistribute and carries
  // unreleased model identifiers. The sanitizer drops it; this keeps it out.
  { name: "Claude Code system prompt", pattern: /"systemPrompt"\s*:/ },
  { name: "Anthropic-style key", pattern: /sk-[A-Za-z0-9_-]{16,}/ },
  { name: "GitHub token", pattern: /\b(gh[pousr]|github_pat)_[A-Za-z0-9_]{16,}/ },
  { name: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "bearer token", pattern: /\bBearer\s+[A-Za-z0-9._-]{20,}/ },
  // Claude writes the signed-in user's address into the transcript context, so
  // this is a real risk rather than a theoretical one. RFC 2606 reserved
  // domains are the sanitizer's own placeholders and are allowed through.
  {
    name: "email address",
    pattern:
      /[A-Za-z0-9._%+-]+@(?!example\.(test|com|org|net)\b)(?!.*\.(invalid|localhost)\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
  },
  { name: "account identifier", pattern: /"ownerAccountUuid"\s*:/ },
  { name: "organization identifier", pattern: /"ownerOrganizationUuid"\s*:/ },
  { name: "cloud bridge session", pattern: /\bcse_[A-Za-z0-9]{10,}/ },
  { name: "peer token", pattern: /"peerToken"\s*:/ },
];

async function walk(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else files.push(path);
  }
  return files;
}

describe("committed fixtures", () => {
  it("contain nothing that must not be published", async () => {
    const files = await walk(FIXTURES);
    const findings: string[] = [];

    for (const file of files) {
      if ((await stat(file)).size > 20_000_000) continue;
      const body = await readFile(file, "utf8");
      for (const rule of FORBIDDEN) {
        const match = rule.pattern.exec(body);
        if (match) findings.push(`${file}: ${rule.name} (${match[0].slice(0, 24)}…)`);
      }
    }

    expect(findings).toEqual([]);
  });
});

describe("the leak check itself", () => {
  it("catches a real address but allows the sanitizer's placeholder", () => {
    const rule = FORBIDDEN.find((r) => r.name === "email address");
    expect(rule?.pattern.test("someone@example.test")).toBe(false);
    expect(rule?.pattern.test("nobody@example.com")).toBe(false);
    expect(rule?.pattern.test("real.person@gmail.com")).toBe(true);
    expect(rule?.pattern.test("dev@company.io")).toBe(true);
  });

  it("catches home directories and tokens", () => {
    const home = FORBIDDEN.find((r) => r.name === "real home directory");
    expect(home?.pattern.test("/Users/someone/code")).toBe(true);
    expect(home?.pattern.test("/Users/fixture/code")).toBe(false);

    const gh = FORBIDDEN.find((r) => r.name === "GitHub token");
    expect(gh?.pattern.test("ghp_0123456789abcdefghij")).toBe(true);
  });
});
