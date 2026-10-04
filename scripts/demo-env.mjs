#!/usr/bin/env node
/**
 * Build a synthetic Claude storage tree for the README recordings.
 *
 * Never record against a real ~/.claude: the transcripts hold employer project
 * names, file paths and prompt text, and a GIF in a public README cannot be
 * un-published. Everything here is invented.
 *
 *   node scripts/demo-env.mjs <target-dir>
 */
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

const target = process.argv[2];
if (target === undefined) {
  process.stderr.write("usage: demo-env.mjs <target-dir>\n");
  process.exit(2);
}

/**
 * This script begins by deleting its target, which is only ever safe for a
 * directory it created itself. A session manager that ships a script capable of
 * erasing `~/.claude` would be its own worst bug, so the target must either not
 * exist or carry the marker written below, and a handful of paths are refused
 * outright however they are spelled.
 */
const MARKER = ".termstash-demo";
const PINS = ".termstash-demo-pins";
const dest = resolve(target);
const home = resolve(homedir());

const refuse = (reason) => {
  process.stderr.write(`Refusing to use ${dest}: ${reason}\nNothing was deleted.\n`);
  process.exit(2);
};

for (const [path, what] of [
  [home, "your home directory"],
  [resolve(home, ".claude"), "Claude's real session directory"],
  [resolve(home, ".termstash"), "TermStash's real state directory"],
  [resolve(process.env["CLAUDE_CONFIG_DIR"] ?? "\0"), "the configured CLAUDE_CONFIG_DIR"],
  [resolve(process.env["TERMSTASH_HOME"] ?? "\0"), "the configured TERMSTASH_HOME"],
  [resolve(sep), "the filesystem root"],
]) {
  if (dest === path) refuse(`it is ${what}`);
}
if (home === dest || home.startsWith(`${dest}${sep}`)) refuse("it contains your home directory");
if (existsSync(dest) && !existsSync(join(dest, MARKER))) {
  refuse(`it already exists and has no ${MARKER} marker, so this script did not create it`);
}

const DAY = 86_400_000;
const now = Date.now();

/** Sessions chosen to show every marker the list can produce. */
const SESSIONS = [
  { id: "7f31a2c4-0000-4000-8000-000000000001", project: "payments-api",
    title: "Stripe webhook retries", prompt: "the webhook retries are firing twice on 5xx",
    ageDays: 0.008, pin: true, live: true },
  { id: "91bc2218-0000-4000-8000-000000000002", project: "payments-api",
    title: "Redis connection pool", prompt: "connection pool exhausts under load, find why",
    ageDays: 0.15 },
  { id: "aa71f903-0000-4000-8000-000000000003", project: "web-client",
    title: "Checkout timeout", prompt: "checkout times out on slow networks",
    ageDays: 1.2 },
  { id: "3e8fee55-0000-4000-8000-000000000004", project: "billing-service",
    title: "Invoice rounding", prompt: "invoice totals are off by one cent on some currencies",
    ageDays: 4 },
  { id: "c4d19a70-0000-4000-8000-000000000005", project: "platform-infra",
    title: "Terraform state lock", prompt: "terraform state keeps locking in CI",
    ageDays: 24 },
  { id: "d5e5f2a6-0000-4000-8000-000000000006", project: "billing-service",
    title: "Stripe payout reconciliation", prompt: "reconcile stripe payouts against our ledger",
    ageDays: 26 },
];

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
writeFileSync(join(dest, MARKER), "Created by scripts/demo-env.mjs. Safe to delete.\n");

for (const s of SESSIONS) {
  const cwd = `/Users/you/work/${s.project}`;
  const bucket = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  const dir = join(dest, "projects", bucket);
  mkdirSync(dir, { recursive: true });

  const at = new Date(now - s.ageDays * DAY).toISOString();
  const base = { sessionId: s.id, cwd, gitBranch: "main", version: "2.1.269", entrypoint: "cli" };
  const records = [
    { type: "mode", mode: "normal", sessionId: s.id },
    { ...base, type: "user", uuid: "u1", parentUuid: null, timestamp: at,
      message: { role: "user", content: s.prompt } },
    { ...base, type: "assistant", uuid: "a1", parentUuid: "u1", timestamp: at,
      message: { role: "assistant", content: [{ type: "text", text: "Looking into it." }] } },
    { type: "ai-title", aiTitle: s.title, sessionId: s.id },
  ];

  const path = join(dir, `${s.id}.jsonl`);
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const mtime = new Date(now - s.ageDays * DAY);
  utimesSync(path, mtime, mtime);

  if (s.live) {
    const live = join(dest, "sessions");
    mkdirSync(live, { recursive: true });
    // pid 1 is init/launchd: always running, on every platform, so the
    // liveness check treats this session as open however long after the
    // environment was built the recording happens.
    writeFileSync(join(live, "1.json"), JSON.stringify({ pid: 1, sessionId: s.id, cwd }));
  }
}

// Prompt history for sessions Claude has already swept - the search result that
// no other tool can produce.
const history = [
  { display: "why is the stripe signature check failing on staging", project: "/Users/you/work/payments-api",
    sessionId: "e712ab90-0000-4000-8000-00000000000a", timestamp: now - 94 * DAY },
  { display: "add stripe idempotency keys to the retry path", project: "/Users/you/work/payments-api",
    sessionId: "e712ab90-0000-4000-8000-00000000000a", timestamp: now - 94 * DAY + 3600_000 },
  { display: "migrate the old stripe plans to the new price ids", project: "/Users/you/work/billing-service",
    sessionId: "21dd8134-0000-4000-8000-00000000000b", timestamp: now - 140 * DAY },
];
writeFileSync(
  join(dest, "history.jsonl"),
  history.map((h) => JSON.stringify({ pastedContents: {}, ...h })).join("\n") + "\n",
);

// The ids the recording should pin before it rolls.
//
// `pin: true` sat in the table above reading like a setting and doing nothing:
// nothing consulted it, so no archive was ever made and `list` drew no star —
// while the README's first image was captioned "showing sessions with
// protection". The hero shot of a tool whose point is protection showed every
// marker except that one. The pin is done by `termstash pin` itself rather
// than forged here, so what the recording shows is a real archive.
writeFileSync(
  join(dest, PINS),
  SESSIONS.filter((s) => s.pin === true).map((s) => s.id).join("\n") + "\n",
);

process.stdout.write(`demo environment: ${dest}\n`);
