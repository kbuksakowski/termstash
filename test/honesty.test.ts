import { rm, stat, writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { discoverSessions } from "../src/adapters/claude/discover.js";
import { writeArchive } from "../src/core/archive/store.js";
import { runDoctor } from "../src/core/doctor/run.js";
import { updateSession } from "../src/core/metadata/store.js";
import { metadataFile } from "../src/core/paths.js";
import { parseArgs } from "../src/cli/args.js";
import { HELP } from "../src/cli/help.js";
import { listCommand } from "../src/cli/list.js";
import { resumeCommand } from "../src/cli/resume.js";
import { searchCommand } from "../src/cli/search.js";
import { allSessions } from "../src/cli/sessions.js";
import { writeTranscript } from "./helpers/sandbox.js";

/**
 * The product's whole claim is that it does not overstate. Each of these was a
 * place where it did — a count presented as a fact when the scan was partial,
 * a session declared missing while a verified copy of it sat two directories
 * away, a benchmark that was never reproducible.
 */

const ID = "aaaaaaaa-0000-4000-8000-000000000001";
const OTHER = "bbbbbbbb-0000-4000-8000-000000000002";
const CWD = "/tmp/backend_api";
const NOW = new Date("2026-10-03T12:00:00Z");

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

async function seed(id: string, prompt: string): Promise<string> {
  return writeTranscript({
    id,
    cwd: CWD,
    records: [
      {
        type: "user",
        message: { role: "user", content: prompt },
        timestamp: "2026-10-01T10:00:00Z",
        sessionId: id,
        cwd: CWD,
      },
    ],
  });
}

/** Pin a session and then let Claude's sweep take the live transcript. */
async function pinThenSweep(id: string, prompt: string): Promise<void> {
  const path = await seed(id, prompt);
  const outcome = await writeArchive(home(), {
    sessionId: id,
    sourcePath: path,
    sizeBytes: (await stat(path)).size,
    mtime: new Date("2026-10-01T10:00:00Z"),
    projectPath: CWD,
    projectDirName: "-tmp-backend-api",
    claudeVersions: [],
  });
  expect(outcome.status).toBe("created");
  await updateSession(home(), id, (current) => ({ ...current, pinned: true }));
  await rm(path);
}

describe("a pinned session survives the sweep in every command, not just restore", () => {
  it("stays in list, marked protected and swept", async () => {
    // It vanished from `list` entirely at the moment Claude swept it, which is
    // the one moment the star was for. `list --json` said "unprotected" while
    // metadata.json said "protected-current" and doctor said the archive was
    // fine: three answers to one question.
    await pinThenSweep(ID, "the stripe webhook retry logic");
    const lines = capture();

    expect(await listCommand(parseArgs(["list"]), NOW)).toBe(0);

    const text = lines.join("");
    expect(text).toContain("★▪");
    expect(text).toContain("swept by Claude");
  });

  it("reports the same protection in --json as metadata.json holds", async () => {
    await pinThenSweep(ID, "hello");
    const lines = capture();

    await listCommand(parseArgs(["list", "--json"]), NOW);

    const payload = JSON.parse(lines.join("")) as {
      sessions: Array<Record<string, unknown>>;
      searched: Record<string, unknown>;
    };
    expect(payload.sessions).toHaveLength(1);
    expect(payload.sessions[0]?.["protectionState"]).toBe("protected-current");
    expect(payload.sessions[0]?.["archivedOnly"]).toBe(true);
    // The envelope is the point: a script reads stdout and the exit code, and
    // both said "complete" while stderr carried the correction.
    expect(payload.searched["scanPartial"]).toBe(false);
  });

  it("is found by search, in the archive that is now the only copy", async () => {
    // search named two sources and there were three, and the third was the one
    // place the text still existed - because the user had pinned it.
    await pinThenSweep(ID, "the stripe webhook retry logic");
    const lines = capture();

    await searchCommand(parseArgs(["search", "webhook"]), { now: NOW });

    const text = lines.join("");
    expect(text).toContain("ARCHIVED — RESTORABLE");
    expect(text).toContain("termstash restore");
    expect(text).toContain("1 archive");
  });

  it("does not call an archived match resumable in --json", async () => {
    await pinThenSweep(ID, "the stripe webhook retry logic");
    const lines = capture();

    await searchCommand(parseArgs(["search", "webhook", "--json"]), { now: NOW });

    const payload = JSON.parse(lines.join("")) as {
      sessions: Array<{ resumable: boolean; state?: string }>;
      searched: { sources: string[]; archives: number };
    };
    expect(payload.sessions[0]?.resumable).toBe(false);
    expect(payload.sessions[0]?.state).toBe("archived");
    expect(payload.searched.sources).toContain("TermStash archives");
    expect(payload.searched.archives).toBe(1);
  });

  it("tells resume what actually happened, and what to do about it", async () => {
    // "No session matches" was false: the session matched, in the archive.
    await pinThenSweep(ID, "hello");
    const lines = capture();

    expect(await resumeCommand(parseArgs(["resume", ID]), { now: NOW })).toBe(1);

    const text = lines.join("");
    expect(text).not.toContain("No session matches");
    expect(text).toContain("termstash restore");
  });

  it("is reachable through allSessions with the archive alongside it", async () => {
    await pinThenSweep(ID, "hello");
    await seed(OTHER, "still live");

    const set = await allSessions({
      root: home(),
      discover: () => discoverSessions({ now: NOW }),
    });

    expect(set.sessions.map((s) => s.id).sort()).toEqual([ID, OTHER].sort());
    expect(set.sessions.find((s) => s.id === ID)?.archivedOnly).toBe(true);
    expect(set.sessions.find((s) => s.id === OTHER)?.archivedOnly).toBeUndefined();
    expect(set.archives.has(ID)).toBe(true);
  });
});

describe("absence is only evidence when the looking was complete", () => {
  const unreadable = [{ path: "/x/projects", reason: "EACCES" }];

  it("does not call sessions unresumable when a location could not be read", async () => {
    // One chmod 000 on projects/ made doctor state that 321 intact sessions
    // were "no longer resumable".
    const report = await runDoctor({
      sessions: [],
      artifacts: [],
      unreadable,
      orphans: [],
      termstashRoot: home(),
      history: {
        lost: [{ id: ID, lastSeen: new Date("2026-09-01T00:00:00Z"), projectPath: CWD }],
        unattributed: 0,
      },
    });

    const finding = report.findings.find((f) => f.code === "historical-sessions");
    expect(finding?.summary).not.toContain("no longer resumable");
    expect(finding?.details.join(" ")).toContain("could not be read");
    expect(report.scanPartial).toBe(true);
  });

  it("still states it plainly when the scan was complete", async () => {
    const report = await runDoctor({
      sessions: [],
      artifacts: [],
      unreadable: [],
      orphans: [],
      termstashRoot: home(),
      history: {
        lost: [{ id: ID, lastSeen: new Date("2026-09-01T00:00:00Z"), projectPath: CWD }],
        unattributed: 0,
      },
    });

    const finding = report.findings.find((f) => f.code === "historical-sessions");
    expect(finding?.summary).toContain("no longer resumable");
    expect(report.scanPartial).toBe(false);
  });

  it("says search may have missed sessions it could not reach", async () => {
    const lines = capture();

    await searchCommand(parseArgs(["search", "anything"]), {
      now: NOW,
      discover: async () => ({ sessions: [], artifacts: [], unreadable }),
    });

    expect(lines.join("")).toContain("could not be read at all");
  });

  it("distinguishes nothing found from nothing readable in list", async () => {
    const lines = capture();

    await listCommand(parseArgs(["list"]), NOW);
    expect(lines.join("")).toContain("No Claude Code sessions found.");
  });
});

describe("a command that cannot see the pins says so where it would have shown them", () => {
  it("names the unreadable metadata instead of showing an unpinned list", async () => {
    // Every pin vanished from `list` with no warning, and `list --pinned` went
    // further and asserted there were none.
    await seed(ID, "hello");
    await writeFile(metadataFile(home()), '{"schemaVersion":1,"sessions":{ broken');
    const lines = capture();

    expect(await listCommand(parseArgs(["list"]), NOW)).toBe(0);

    const text = lines.join("");
    expect(text).toContain("could not read its own metadata");
    expect(text).toContain("no pin or title is shown");
  });

  it("says it on the filtered view too, where the claim was strongest", async () => {
    await seed(ID, "hello");
    await writeFile(metadataFile(home()), '{"schemaVersion":1,"sessions":{ broken');
    const lines = capture();

    await listCommand(parseArgs(["list", "--pinned"]), NOW);

    expect(lines.join("")).toContain("could not read its own metadata");
  });
});

describe("the help footer describes what the tool does", () => {
  it("does not claim it never writes to Claude's storage", () => {
    // `restore` writes a transcript back into Claude's projects directory and
    // `hook install` edits settings.json. Both are the point of the commands;
    // only the footer disagreed.
    expect(HELP).not.toContain("never writes to it");
    expect(HELP).toContain("restore");
    expect(HELP).toContain("settings.json");
  });
});
