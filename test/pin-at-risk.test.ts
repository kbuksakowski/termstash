import { stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseArgs } from "../src/cli/args.js";
import { pinCommand } from "../src/cli/pin.js";
import { readMetadata } from "../src/core/metadata/store.js";
import { conversation, writeTranscript } from "./helpers/sandbox.js";

/**
 * `pin --at-risk`: the remedy `doctor` offers a first-time reader, in one line
 * rather than one `pin <id>` per session. It must protect exactly what
 * `list --at-risk` shows and nothing else, and say what it did to each.
 */

const NOW = new Date("2026-10-04T12:00:00Z");
const DAY = 86_400_000;
const OLD = "aaaaaaaa-0000-4000-8000-000000000001"; // 26 days: at risk
const OLDER = "bbbbbbbb-0000-4000-8000-000000000002"; // 28 days: at risk
const FRESH = "cccccccc-0000-4000-8000-000000000003"; // 2 days: fine

function home(): string {
  const value = process.env["TERMSTASH_HOME"];
  if (value === undefined) throw new Error("TERMSTASH_HOME not set");
  return value;
}

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((c) => (stdout.push(String(c)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((c) => (stderr.push(String(c)), true));
  return { stdout, stderr, all: () => stdout.join("") + stderr.join("") };
}

async function session(id: string, ageDays: number, cwd = `/tmp/${id.slice(0, 4)}`) {
  return writeTranscript({
    id,
    cwd,
    records: conversation({ id, cwd, prompt: `work in ${id.slice(0, 4)}` }),
    mtime: new Date(NOW.getTime() - ageDays * DAY),
  });
}

async function archived(id: string): Promise<boolean> {
  return stat(join(home(), "archive", id, "transcript.jsonl")).then(() => true, () => false);
}

describe("pin --at-risk", () => {
  it("pins and archives every at-risk session, and nothing else", async () => {
    await session(OLD, 26);
    await session(OLDER, 28);
    await session(FRESH, 2);
    const io = capture();

    expect(await pinCommand(parseArgs(["pin", "--at-risk"]), { now: NOW })).toBe(0);

    expect(await archived(OLD)).toBe(true);
    expect(await archived(OLDER)).toBe(true);
    expect(await archived(FRESH)).toBe(false);
    const pins = (await readMetadata(home())).sessions;
    expect(pins[OLD]?.pinned).toBe(true);
    expect(pins[FRESH]).toBeUndefined();
    expect(io.all()).toContain("Pinning 2 sessions");
    expect(io.all()).toContain("2 of 2 pinned and archived.");
  });

  it("says how much it is about to copy before it copies anything", async () => {
    await session(OLD, 26);
    const io = capture();
    await pinCommand(parseArgs(["pin", "--at-risk"]), { now: NOW });
    const first = io.stdout[0] ?? "";
    expect(first).toMatch(/Pinning 1 session approaching .* \(\d+ KB to copy\)/);
  });

  it("does nothing, and says so, when nothing is at risk", async () => {
    await session(FRESH, 2);
    const io = capture();
    expect(await pinCommand(parseArgs(["pin", "--at-risk"]), { now: NOW })).toBe(0);
    expect(io.all()).toContain("Nothing to pin");
    expect(await archived(FRESH)).toBe(false);
  });

  it("is safe to run twice", async () => {
    await session(OLD, 26);
    capture();
    await pinCommand(parseArgs(["pin", "--at-risk"]), { now: NOW });
    const io = capture();
    expect(await pinCommand(parseArgs(["pin", "--at-risk"]), { now: NOW })).toBe(0);
    expect(io.all()).toContain("1 of 1 pinned and archived.");
  });

  it("refuses an id and the flag together rather than guessing which was meant", async () => {
    await session(OLD, 26);
    const io = capture();
    expect(await pinCommand(parseArgs(["pin", OLD, "--at-risk"]), { now: NOW })).toBe(1);
    expect(io.all()).toContain("not both");
    expect(await archived(OLD)).toBe(false);
  });

  it("skips an id that names two transcripts, says so, and exits non-zero", async () => {
    await session(OLD, 26, "/tmp/alpha");
    await session(OLD, 26, "/tmp/beta");
    await session(OLDER, 28);
    const io = capture();

    expect(await pinCommand(parseArgs(["pin", "--at-risk"]), { now: NOW })).toBe(1);
    expect(io.all().match(/more than one project directory/g)).toHaveLength(1);
    expect(io.all()).toContain("Pinning 2 sessions");
    expect(io.all()).toContain("NOT protected");
    // The unambiguous one is still protected; one bad session does not stop the rest.
    expect(await archived(OLDER)).toBe(true);
    expect(await archived(OLD)).toBe(false);
  });
});
