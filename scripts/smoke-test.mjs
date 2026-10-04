#!/usr/bin/env node
/**
 * End-to-end check against a synthetic Claude storage tree.
 *
 * This is what stands behind calling a platform supported: not "the unit tests
 * pass", but the built CLI driving a real filesystem through the whole
 * lifecycle. Everything except `resume` runs here; resume delegates to the
 * `claude` binary, which CI does not have.
 *
 *   node scripts/smoke-test.mjs
 *
 * Requires CLAUDE_CONFIG_DIR and TERMSTASH_HOME to point somewhere disposable.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const SESSION = "aaaaaaaa-1111-4222-8333-444444444444";

const claudeHome = process.env["CLAUDE_CONFIG_DIR"] ?? mkdtempSync(join(tmpdir(), "smoke-claude-"));
const termstashHome = process.env["TERMSTASH_HOME"] ?? mkdtempSync(join(tmpdir(), "smoke-termstash-"));

// Never run this against someone's real data. Comparing against the default
// location is not enough: CLAUDE_CONFIG_DIR exists precisely so that people can
// point it somewhere else, and anyone with it set in their shell profile would
// otherwise hand this script their live sessions. So the rule is emptiness —
// this test creates everything it needs and has no business in a directory that
// already holds something.
for (const [name, value] of [["CLAUDE_CONFIG_DIR", claudeHome], ["TERMSTASH_HOME", termstashHome]]) {
  const real = resolve(join(process.env["HOME"] ?? "", name === "CLAUDE_CONFIG_DIR" ? ".claude" : ".termstash"));
  if (resolve(value) === real) {
    fail(`${name} points at the real directory (${real}). Refusing to run.`);
  }
  const existing = existsSync(value) ? readdirSync(value) : [];
  if (existing.length > 0) {
    fail(`${name} (${resolve(value)}) is not empty. Refusing to run against existing data.`);
  }
}

const env = { ...process.env, CLAUDE_CONFIG_DIR: claudeHome, TERMSTASH_HOME: termstashHome };
let step = 0;

function run(args, { expectFailure = false } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { env, encoding: "utf8" });
    if (expectFailure) fail(`expected 'termstash ${args.join(" ")}' to fail, but it succeeded`);
    return stdout;
  } catch (error) {
    if (!expectFailure) {
      fail(`'termstash ${args.join(" ")}' failed:\n${error.stdout ?? ""}${error.stderr ?? ""}`);
    }
    return `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
}

function check(label, condition, context = "") {
  step += 1;
  if (condition) {
    process.stdout.write(`  ✓ ${step}. ${label}\n`);
    return;
  }
  fail(`${label}\n${context}`);
}

function fail(message) {
  process.stderr.write(`\n  ✗ ${message}\n`);
  process.exit(1);
}

process.stdout.write(`\nSmoke test on ${process.platform}, node ${process.versions.node}\n\n`);

// --- a machine that has never run Claude Code ---------------------------------
check("a machine with no sessions reports none, without erroring",
  run(["list"]).includes("No Claude Code sessions found"));
check("doctor on an empty machine reports nothing wrong",
  run(["doctor"]).includes("Nothing to report"));

// --- a session appears --------------------------------------------------------
const projectCwd = join(claudeHome, "workspace", "demo_project");
mkdirSync(projectCwd, { recursive: true });
const bucket = join(claudeHome, "projects", projectCwd.replace(/[^a-zA-Z0-9]/g, "-"));
mkdirSync(bucket, { recursive: true });

const base = { sessionId: SESSION, cwd: projectCwd, gitBranch: "main", version: "2.1.269", entrypoint: "cli" };
const transcript = [
  { type: "mode", mode: "normal", sessionId: SESSION },
  { ...base, type: "user", uuid: "u1", parentUuid: null, timestamp: "2026-09-01T10:00:00.000Z",
    message: { role: "user", content: "investigate the checkout timeout" } },
  { ...base, type: "assistant", uuid: "a1", parentUuid: "u1", timestamp: "2026-09-01T10:00:05.000Z",
    message: { role: "assistant", content: [{ type: "text", text: "Looking at the retry budget." }] } },
  { type: "ai-title", aiTitle: "Checkout timeout", sessionId: SESSION },
];
const transcriptPath = join(bucket, `${SESSION}.jsonl`);
writeFileSync(transcriptPath, transcript.map((r) => JSON.stringify(r)).join("\n") + "\n");

const listed = run(["list"]);
check("list finds the session and names it", listed.includes("Checkout timeout"), listed);
check("list resolves the project from the transcript, not the directory name",
  listed.includes("demo_project"), listed);

const found = run(["search", "checkout"]);
check("search matches a human prompt", found.includes("Checkout timeout"), found);
check("search reports what it searched", found.includes("Searched 1 live session"), found);
check("search finds nothing for an absent term", run(["search", "zzzzzznope"]).includes("No matches"));

// --- protection ---------------------------------------------------------------
const pinned = run(["pin", SESSION.slice(0, 6)]);
check("pin creates an archive in the same operation", pinned.includes("Archive created"), pinned);
check("list marks the session as protected", run(["list", "--pinned"]).includes("★"), run(["list", "--pinned"]));

writeFileSync(transcriptPath, `${readFileSync(transcriptPath, "utf8")}{"type":"mode","mode":"plan"}\n`);
check("an archive that falls behind is not called protection",
  run(["list", "--pinned"]).includes("☆"), run(["list", "--pinned"]));
check("archive refuses to overwrite a stale archive silently",
  run(["archive", SESSION.slice(0, 6)], { expectFailure: true }).includes("--replace"));
check("pin refreshes the stale archive", run(["pin", SESSION.slice(0, 6)]).includes("Archive refreshed"));

// --- the session is swept ------------------------------------------------------
check("restore refuses while the transcript still exists",
  run(["restore", SESSION.slice(0, 6)], { expectFailure: true }).includes("already exists"));

rmSync(transcriptPath);
// This used to assert the opposite, and the opposite was a bug: a pinned
// session disappearing from `list` at the moment Claude sweeps it is the one
// moment the pin was for.
const swept = run(["list"]);
check("list still shows the swept session, marked as protected and swept",
  swept.includes("★▪"), swept);
check("search still finds it, in TermStash's own archive",
  run(["search", "checkout"]).includes("ARCHIVED — RESTORABLE"), run(["search", "checkout"]));
const sweptResume = run(["resume", SESSION.slice(0, 6)], { expectFailure: true });
check("resume names the archive and the way back instead of denying the session",
  sweptResume.includes("termstash restore"), sweptResume);

const restored = run(["restore", SESSION.slice(0, 6)]);
check("restore brings it back and verifies it", restored.includes("restored and verified"), restored);
check("the restored transcript is byte-identical to the archived one",
  readFileSync(transcriptPath, "utf8") ===
    readFileSync(join(termstashHome, "archive", SESSION, "transcript.jsonl"), "utf8"));

// The correction that makes restore durable: Claude sweeps by mtime, so a
// restored transcript carrying its original timestamp would be deleted again.
const age = Date.now() - statSync(transcriptPath).mtimeMs;
check("the restored transcript carries a current mtime, not the archived one",
  age < 60_000, `mtime is ${Math.round(age / 1000)}s old`);
check("list sees it again", run(["list"]).includes("Checkout timeout"));

// --- the duplicate hazard -------------------------------------------------------
const otherBucket = join(claudeHome, "projects", "-elsewhere");
mkdirSync(otherBucket, { recursive: true });
writeFileSync(join(otherBucket, `${SESSION}.jsonl`), readFileSync(transcriptPath));
const duplicate = run(["restore", SESSION.slice(0, 6)], { expectFailure: true });
check("restore refuses a duplicate state outright", duplicate.includes("multiple Claude project"), duplicate);
check("doctor reports the duplicate as confirmed",
  run(["doctor"], { expectFailure: true }).includes("more than one project directory"));
rmSync(otherBucket, { recursive: true });

// --- refusals -------------------------------------------------------------------
check("resume refuses an unknown id", run(["resume", "zzzzzz"], { expectFailure: true }).includes("No session matches"));
check("resume refuses a missing project directory without --cwd", (() => {
  rmSync(projectCwd, { recursive: true });
  const out = run(["resume", SESSION.slice(0, 6)], { expectFailure: true });
  mkdirSync(projectCwd, { recursive: true });
  return out.includes("--cwd");
})());
check("unpin keeps the archive", run(["unpin", SESSION.slice(0, 6)]).includes("archive was kept"));
check("the archive survived every step", readdirSync(join(termstashHome, "archive")).includes(SESSION));

process.stdout.write(`\n  ${step} checks passed\n\n`);
