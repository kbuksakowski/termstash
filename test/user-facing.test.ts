import { mkdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { archiveCommand } from "../src/cli/archive.js";
import { parseArgs } from "../src/cli/args.js";
import { listCommand } from "../src/cli/list.js";
import { pinCommand } from "../src/cli/pin.js";
import { renameCommand } from "../src/cli/rename.js";
import { searchCommand } from "../src/cli/search.js";
import { runDoctor } from "../src/core/doctor/run.js";
import { claudeRoot } from "../src/adapters/claude/paths.js";
import { discoverSessions } from "../src/adapters/claude/discover.js";
import { findOrphans } from "../src/adapters/claude/orphans.js";
import { pruneAbandonedWork } from "../src/core/archive/store.js";
import { writeTranscript } from "./helpers/sandbox.js";

/**
 * Found by running the built tool as a user and comparing what each command
 * said with what had happened on disk, rather than by reading the code.
 */

const ID = "11111111-1111-4111-8111-111111111111";
const CWD = "/tmp/backend_api";
const NOW = new Date("2026-10-04T12:00:00Z");

function home(): string {
  const value = process.env["TERMSTASH_HOME"];
  if (value === undefined) throw new Error("TERMSTASH_HOME not set");
  return value;
}

function capture(): string[] {
  const lines: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((c) => (lines.push(String(c)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((c) => (lines.push(String(c)), true));
  return lines;
}

function record(tag: string, i: number) {
  return {
    type: "user",
    message: { role: "user", content: `${tag}-${i}` },
    timestamp: "2026-10-01T10:00:00Z",
    sessionId: ID,
    cwd: CWD,
  };
}

describe("search looks in the archive when the live transcript has lost the text", () => {
  it("finds a phrase a compaction removed from the live file", async () => {
    const path = await writeTranscript({
      id: ID,
      cwd: CWD,
      records: [record("keep", 1), record("keep", 2), record("UNOBTAINIUM runbook", 3)],
    });
    expect(await pinCommand(parseArgs(["pin", ID]), { now: NOW })).toBe(0);

    // What a compaction leaves behind: the same session, a shorter transcript.
    await writeFile(path, `${JSON.stringify(record("keep", 1))}\n`);

    const lines = capture();
    expect(await searchCommand(parseArgs(["search", "UNOBTAINIUM"]), { now: NOW })).toBe(0);
    const output = lines.join("");

    // Before this round: "No matches.", with the phrase in the archive the
    // user had pinned the session for.
    expect(output).not.toContain("No matches");
    expect(output).toContain("ONLY IN THE ARCHIVE");
    expect(output).toContain("UNOBTAINIUM");
    // And the footer has to admit the archive was one of the places looked at.
    expect(output).toContain("1 archive");
  });

  it("does not report a session twice when the archive is a prefix of the live file", async () => {
    const path = await writeTranscript({
      id: ID,
      cwd: CWD,
      records: [record("widgets", 1), record("widgets", 2)],
    });
    expect(await pinCommand(parseArgs(["pin", ID]), { now: NOW })).toBe(0);
    // The ordinary case: the session kept going, so the live file extends the
    // archive and searching it covers both copies.
    await writeFile(path, `${JSON.stringify(record("widgets", 1))}\n${JSON.stringify(record("widgets", 2))}\n${JSON.stringify(record("widgets", 3))}\n`);

    const lines = capture();
    await searchCommand(parseArgs(["search", "widgets"]), { now: NOW });
    const output = lines.join("");

    expect(output).toContain("Found 1 match");
    expect(output).not.toContain("ONLY IN THE ARCHIVE");
  });
});

describe("working files a killed run left behind", () => {
  it("removes the aged ones, leaves fresh ones and never a kept previous archive", async () => {
    const archiveRoot = join(home(), "archive");
    const old = join(archiveRoot, `.staging-${ID}-aaaa1111`);
    const fresh = join(archiveRoot, `.staging-${ID}-bbbb2222`);
    const kept = join(archiveRoot, `.previous-${ID}-cccc3333`);
    for (const dir of [old, fresh, kept]) {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "transcript.jsonl"), "irreplaceable\n");
    }
    // A staging file, which is the shape `writeMetadata` and `restore` leave.
    const strayFile = join(home(), "metadata.json.termstash-deadbeef");
    await writeFile(strayFile, "x");

    const ancient = new Date("2026-09-01T00:00:00Z");
    for (const path of [old, join(old, "transcript.jsonl"), kept, join(kept, "transcript.jsonl"), strayFile]) {
      await utimes(path, ancient, ancient);
    }
    // Stamped relative to the clock the sweep is given, not the wall clock the
    // file happened to be created on.
    const recent = new Date(NOW.getTime() - 60_000);
    for (const path of [fresh, join(fresh, "transcript.jsonl")]) {
      await utimes(path, recent, recent);
    }

    const removed = await pruneAbandonedWork(home(), NOW);

    expect(removed).toBe(2);
    await expect(stat(old)).rejects.toThrow();
    await expect(stat(strayFile)).rejects.toThrow();
    // Another process may still be copying into this one.
    await expect(stat(fresh)).resolves.toBeDefined();
    // This one is an archive that was kept *because* its replacement did not
    // contain it - the only copy of what the live transcript lost.
    await expect(stat(join(kept, "transcript.jsonl"))).resolves.toBeDefined();
  });

  it("runs on the path that refuses, not only on the one that copies", async () => {
    const path = await writeTranscript({ id: ID, cwd: CWD, records: [record("a", 1)] });
    expect(await pinCommand(parseArgs(["pin", ID]), { now: NOW })).toBe(0);

    const stray = join(home(), "archive", `.staging-${ID}-eeee5555`);
    await mkdir(stray, { recursive: true });
    await writeFile(join(stray, "transcript.jsonl"), "junk\n");
    const ancient = new Date("2026-09-01T00:00:00Z");
    await utimes(join(stray, "transcript.jsonl"), ancient, ancient);
    await utimes(stray, ancient, ancient);

    // Rewrite the live transcript so `archive` answers "stale-refused" - the
    // early return the sweep used to sit below, along with "already-current",
    // which is what the hook gets on a quiet turn.
    await writeFile(path, `${JSON.stringify(record("rewritten", 9))}\n`);
    capture();
    await archiveCommand(parseArgs(["archive", ID]), { now: NOW });

    await expect(stat(stray)).rejects.toThrow();
  });
});

describe("a yes/no flag given a value", () => {
  it("does not replace an archive when told --replace=false", async () => {
    const path = await writeTranscript({ id: ID, cwd: CWD, records: [record("original", 1)] });
    expect(await pinCommand(parseArgs(["pin", ID]), { now: NOW })).toBe(0);
    await writeFile(path, `${JSON.stringify(record("rewritten", 1))}\n`);

    const lines = capture();
    const code = await archiveCommand(parseArgs(["archive", ID, "--replace=false"]), { now: NOW });
    expect(code).toBe(1);
    expect(lines.join("")).toContain("--replace");

    // The word "false" used to turn the flag on, and the overwrite happened.
    const archived = await stat(join(home(), "archive", ID, "transcript.jsonl"));
    expect(archived.size).toBeGreaterThan(0);
    const body = await (await import("node:fs/promises")).readFile(
      join(home(), "archive", ID, "transcript.jsonl"), "utf8");
    expect(body).toContain("original");
    expect(body).not.toContain("rewritten");
  });

  it("refuses a value it cannot read as yes or no rather than guessing", () => {
    expect(() => parseArgs(["list", "--json=maybe"])).toThrow(/yes\/no flag/);
  });

  it("still accepts the flag written plainly", () => {
    expect(parseArgs(["archive", "x", "--replace"]).flags.has("replace")).toBe(true);
    expect(parseArgs(["archive", "x", "--replace=yes"]).flags.has("replace")).toBe(true);
    expect(parseArgs(["archive", "x", "--replace=0"]).flags.has("replace")).toBe(false);
  });
});

describe("list --json says whether the list is complete", () => {
  it("carries the partial scan a script cannot see on stderr", async () => {
    await writeTranscript({ id: ID, cwd: CWD, records: [record("a", 1)] });
    const unreadable = join(claudeRoot(), "projects", "-tmp-locked");
    await mkdir(unreadable, { recursive: true });
    await (await import("node:fs/promises")).chmod(unreadable, 0o000);

    // stdout alone: the whole point is that the warning on stderr never
    // reaches a script, so the test must read what a script reads.
    const stdout: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((c) => (stdout.push(String(c)), true));
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await listCommand(parseArgs(["list", "--json"]), NOW);
    await (await import("node:fs/promises")).chmod(unreadable, 0o755);

    const payload = JSON.parse(stdout.join("")) as {
      sessions: unknown[];
      searched: { scanPartial: boolean; unreadableLocations: string[] };
    };
    expect(payload.sessions).toHaveLength(1);
    expect(payload.searched.scanPartial).toBe(true);
    expect(payload.searched.unreadableLocations).toHaveLength(1);
  });
});

describe("one session id in two project directories", () => {
  it("is refused rather than resolved to whichever the scan reached first", async () => {
    await writeTranscript({ id: ID, cwd: "/tmp/alpha", records: [record("alpha", 1)] });
    await writeTranscript({ id: ID, cwd: "/tmp/beta", records: [record("beta", 1), record("beta", 2)] });

    const lines = capture();
    expect(await pinCommand(parseArgs(["pin", ID]), { now: NOW })).toBe(1);
    expect(lines.join("")).toContain("exists in 2 project directories");
    // Nothing was archived, and no star was drawn over two different sessions.
    await expect(stat(join(home(), "archive", ID))).rejects.toThrow();
  });

  it("is refused by rename, which used to retitle both", async () => {
    await writeTranscript({ id: ID, cwd: "/tmp/alpha", records: [record("alpha", 1)] });
    await writeTranscript({ id: ID, cwd: "/tmp/beta", records: [record("beta", 1)] });
    capture();
    expect(await renameCommand(parseArgs(["rename", ID, "Title"]))).toBe(1);
  });

  it("is a confirmed doctor finding, because nothing else could say it existed", async () => {
    await writeTranscript({ id: ID, cwd: "/tmp/alpha", records: [record("alpha", 1)] });
    await writeTranscript({ id: ID, cwd: "/tmp/beta", records: [record("beta", 1)] });

    const discovery = await discoverSessions({ now: NOW });
    const report = await runDoctor({
      sessions: discovery.sessions,
      artifacts: discovery.artifacts,
      unreadable: discovery.unreadable,
      orphans: await findOrphans(claudeRoot(), new Set(discovery.sessions.map((s) => s.id))),
      termstashRoot: home(),
    });
    const finding = report.findings.find((f) => f.code === "duplicate-session-id");
    expect(finding?.class).toBe("confirmed");
    expect(finding?.details?.join(" ")).toContain(ID);
  });
});
