/**
 * Rewrite a recorded transcript into something safe to commit.
 *
 * Even a synthetic session carries the recording machine's home directory,
 * username, hostname and git branch, and may carry account identifiers. This
 * repository is meant to be public and a push is not retractable, so the
 * rewrite is mechanical and the result is checked by a test that blocks merges.
 *
 *   npx tsx scripts/sanitize-fixture.ts <input.jsonl> <output.jsonl> [--cwd /fixture/project]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";

const FIXTURE_HOME = "/Users/fixture";
const FIXTURE_USER = "fixture";
const FIXTURE_HOST = "fixture-host";

/** Dropped wholesale: these identify an account or a live connection. */
const DROP_KEYS = new Set([
  "ownerAccountUuid",
  "ownerOrganizationUuid",
  "bridgeSessionId",
  "peerToken",
  "messagingSocketPath",
  "requestId",
  "userID",
  "accountUuid",
  "organizationUuid",
  // Not ours to redistribute: Claude Code writes its own system prompt into
  // the transcript, and it carries unreleased model identifiers. It was 77% of
  // every fixture recorded before this rule existed, and no test reads it.
  "systemPrompt",
  // The environment snapshot carries the recording machine's working
  // directory, OS version and shell. Nothing parses it.
  "snapshot",
  // Claude's rendered text copy of an attachment payload. Dropping `snapshot`
  // alone left the same working directory behind here as prose, inside a
  // <system-reminder> block. Nothing in src/ reads it. If a fixture ever needs
  // rendered content, scrub it here rather than putting the field back.
  "rendered",
]);

/**
 * Keys holding the working directory. Claude writes it under more than one
 * name, and a rewrite keyed on "cwd" alone left the real path in
 * `attachment.snapshot.workingDirectory` of every fixture recorded before this.
 */
const PATH_KEYS = new Set(["cwd", "workingDirectory"]);

/** Claude names a project directory by replacing every non-alphanumeric with a dash. */
function mangle(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, "-");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const TOKEN_PATTERNS: [RegExp, string][] = [
  [/sk-[A-Za-z0-9_-]{16,}/g, "sk-REDACTED"],
  [/\b(gh[pousr]|github_pat)_[A-Za-z0-9_]{16,}/g, "ghp_REDACTED"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "AKIAREDACTED00000000"],
  [/\bcse_[A-Za-z0-9]{10,}/g, "cse_REDACTED"],
  [/\bBearer\s+[A-Za-z0-9._-]{20,}/g, "Bearer REDACTED"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "someone@example.test"],
];

function scrubText(value: string, cwdOverride?: string): string {
  let out = value;
  const home = homedir();
  const user = userInfo().username;

  if (cwdOverride !== undefined) {
    out = out.split(process.cwd()).join(cwdOverride);
    out = out.split(mangle(process.cwd())).join(mangle(cwdOverride));
  }
  out = out.split(home).join(FIXTURE_HOME);
  // Claude's own project directory names are the mangled form, so the plain
  // rewrite above never sees them. This is the form a real home path actually
  // takes inside a transcript.
  out = out.split(mangle(home)).join(mangle(FIXTURE_HOME));
  // After the home rewrite, a bare username can still appear in branches or
  // URLs. Bounded rather than a blind substring, so a short username is handled
  // rather than skipped.
  out = out.replace(new RegExp(`\\b${escapeRegExp(user)}\\b`, "g"), FIXTURE_USER);
  out = out.split(hostname()).join(FIXTURE_HOST);
  out = out.replace(/\/(Users|home)\/[A-Za-z0-9._-]+/g, `/$1/${FIXTURE_USER}`);
  out = out.replace(/-(Users|home)-[A-Za-z0-9]+/g, `-$1-${FIXTURE_USER}`);
  out = out.replace(/[A-Za-z]:\\Users\\[A-Za-z0-9._-]+/g, `C:\\Users\\${FIXTURE_USER}`);
  for (const [pattern, replacement] of TOKEN_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

function scrub(value: unknown, cwdOverride?: string): unknown {
  if (typeof value === "string") return scrubText(value, cwdOverride);
  if (Array.isArray(value)) return value.map((item) => scrub(item, cwdOverride));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (DROP_KEYS.has(key)) continue;
      if (PATH_KEYS.has(key) && cwdOverride !== undefined && typeof item === "string") {
        out[key] = cwdOverride;
        continue;
      }
      out[key] = scrub(item, cwdOverride);
    }
    return out;
  }
  return value;
}

const [input, output, ...rest] = process.argv.slice(2);
if (input === undefined || output === undefined) {
  process.stderr.write("usage: sanitize-fixture.ts <input.jsonl> <output.jsonl> [--cwd <path>]\n");
  process.exit(2);
}

const cwdIndex = rest.indexOf("--cwd");
const cwdOverride = cwdIndex === -1 ? undefined : rest[cwdIndex + 1];

const lines = readFileSync(input, "utf8").split("\n").filter((l) => l.trim() !== "");
const cleaned = lines.map((line) => JSON.stringify(scrub(JSON.parse(line), cwdOverride)));
writeFileSync(output, `${cleaned.join("\n")}\n`);
process.stdout.write(`${lines.length} records → ${output}\n`);
