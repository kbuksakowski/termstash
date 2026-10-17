import { describe, expect, it, vi } from "vitest";
import { parseArgs } from "../src/cli/args.js";
import { lastCommand } from "../src/cli/last.js";
import { conversation, writeLiveSession, writeTranscript } from "./helpers/sandbox.js";

/**
 * `last`: the sessions you were most recently in that are no longer open.
 * The question asked after a laptop lid closes and a terminal comes back
 * without the session in it.
 */

const NOW = new Date("2026-10-17T12:00:00Z");
const MIN = 60_000;
const ids = {
  newest: "aaaaaaaa-0000-4000-8000-000000000001",
  older: "bbbbbbbb-0000-4000-8000-000000000002",
  oldest: "cccccccc-0000-4000-8000-000000000003",
  live: "dddddddd-0000-4000-8000-000000000004",
  headless: "eeeeeeee-0000-4000-8000-000000000005",
};

function capture() {
  const stdout: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((c) => (stdout.push(String(c)), true));
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  return () => stdout.join("");
}

async function session(id: string, minutesAgo: number, options: { entrypoint?: string; title?: string } = {}) {
  const cwd = `/tmp/${id.slice(0, 4)}`;
  await writeTranscript({
    id,
    cwd,
    records: conversation({
      id,
      cwd,
      prompt: options.title ?? `work in ${id.slice(0, 4)}`,
      ...(options.entrypoint !== undefined ? { entrypoint: options.entrypoint } : {}),
    }),
    mtime: new Date(NOW.getTime() - minutesAgo * MIN),
  });
}

describe("termstash last", () => {
  it("lists closed sessions newest first, and offers to resume the first", async () => {
    await session(ids.oldest, 30);
    await session(ids.newest, 2);
    await session(ids.older, 10);
    const output = capture();

    expect(await lastCommand(parseArgs(["last"]), { now: NOW })).toBe(0);
    const text = output();
    expect(text.indexOf("aaaaaa")).toBeLessThan(text.indexOf("bbbbbb"));
    expect(text.indexOf("bbbbbb")).toBeLessThan(text.indexOf("cccccc"));
    expect(text).toContain("termstash resume aaaaaa");
  });

  it("leaves out the session that is still open - that one is not lost", async () => {
    await session(ids.live, 0);
    await writeLiveSession(process.pid, ids.live);
    await session(ids.older, 10);
    const output = capture();

    await lastCommand(parseArgs(["last"]), { now: NOW });
    expect(output()).not.toContain("dddddd");
    expect(output()).toContain("termstash resume bbbbbb");
  });

  it("leaves out headless claude -p runs, which nobody was sitting in", async () => {
    await session(ids.headless, 1, { entrypoint: "sdk-cli" });
    await session(ids.older, 10);
    const output = capture();

    await lastCommand(parseArgs(["last"]), { now: NOW });
    expect(output()).not.toContain("eeeeee");
  });

  it("shows five by default and honours --limit", async () => {
    for (let i = 1; i <= 7; i += 1) {
      await session(`ffffff0${i}-0000-4000-8000-00000000000${i}`, i);
    }
    let output = capture();
    await lastCommand(parseArgs(["last"]), { now: NOW });
    expect(output().match(/ffffff0/g)).toHaveLength(5 + 1); // five rows, plus the resume line
    vi.restoreAllMocks();

    output = capture();
    await lastCommand(parseArgs(["last", "--limit", "2"]), { now: NOW });
    expect(output().match(/ffffff0/g)).toHaveLength(2 + 1);
  });

  it("gives an agent the command to type, and says whether the scan was complete", async () => {
    await session(ids.newest, 2, { title: "Payout reconciliation" });
    const output = capture();

    await lastCommand(parseArgs(["last", "--json"]), { now: NOW });
    const payload = JSON.parse(output()) as {
      sessions: Array<{ id: string; shortId: string; title: string; resume: string }>;
      searched: { scanPartial: boolean };
    };
    expect(payload.sessions[0]).toMatchObject({
      id: ids.newest,
      shortId: "aaaaaa",
      resume: "termstash resume aaaaaa",
    });
    expect(payload.searched.scanPartial).toBe(false);
  });

  it("says so when every session is still open", async () => {
    await session(ids.live, 0);
    await writeLiveSession(process.pid, ids.live);
    const output = capture();

    expect(await lastCommand(parseArgs(["last"]), { now: NOW })).toBe(0);
    expect(output()).toContain("Every session found is still open");
  });
});
