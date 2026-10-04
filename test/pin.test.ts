import { readFile, stat, writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { Discovery } from "../src/adapters/claude/discover.js";
import { readArchive } from "../src/core/archive/store.js";
import { protectionState } from "../src/core/archive/protection.js";
import { readMetadata } from "../src/core/metadata/store.js";
import { metadataFile } from "../src/core/paths.js";
import type { Session } from "../src/core/session/types.js";
import { parseArgs } from "../src/cli/args.js";
import { pinCommand, unpinCommand } from "../src/cli/pin.js";
import { conversation, writeTranscript } from "./helpers/sandbox.js";

const ID = "aaaaaaaa-0000-4000-8000-000000000001";
const CWD = "/tmp/backend_api";
const NOW = new Date("2026-09-12T12:00:00.000Z");

function home(): string {
  const value = process.env["TERMSTASH_HOME"];
  if (value === undefined) throw new Error("TERMSTASH_HOME not set");
  return value;
}

async function seed(prompt = "fix the webhook"): Promise<{ session: Session; path: string }> {
  const path = await writeTranscript({
    id: ID,
    cwd: CWD,
    records: conversation({ id: ID, cwd: CWD, prompt }),
  });
  const info = await stat(path);
  const session: Session = {
    id: ID,
    agent: "claude-code",
    agentVersions: ["2.1.263"],
    sourcePath: path,
    projectDirName: "-tmp-backend-api",
    projectPath: CWD,
    projectName: "backend_api",
    projectPathExists: false,
    updatedAt: info.mtime,
    sizeBytes: info.size,
    origin: "interactive",
    isLive: false,
    hasSubagents: false,
    hasToolResults: false,
    retention: { status: "ok", ageDays: 0 },
    parseWarnings: [],
  };
  return { session, path };
}

const deps = (session: Session) => ({
  discover: async (): Promise<Discovery> => ({ sessions: [session], artifacts: [], unreadable: [] }),
  root: home(),
  now: NOW,
});

function captureOut(): string[] {
  const out: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((c) => (out.push(String(c)), true));
  return out;
}

describe("pinCommand", () => {
  it("pins and creates a verified archive in one operation", async () => {
    const { session } = await seed();
    const out = captureOut();

    const code = await pinCommand(parseArgs(["pin", ID]), deps(session));
    expect(code).toBe(0);
    expect(out.join("")).toMatch(/pinned/);
    expect(out.join("")).toMatch(/Archive created/);

    const metadata = await readMetadata(home());
    expect(metadata.sessions[ID]?.pinned).toBe(true);
    expect(metadata.sessions[ID]?.protectionState).toBe("protected-current");
    expect(await readArchive(home(), ID)).toBeDefined();
  });

  it("does not copy again when the archive is already current", async () => {
    const { session } = await seed();
    await pinCommand(parseArgs(["pin", ID]), deps(session));
    const out = captureOut();
    const code = await pinCommand(parseArgs(["pin", ID]), deps(session));
    expect(code).toBe(0);
    expect(out.join("")).toMatch(/same size and timestamp/);
  });

  it("refreshes an archive that fell behind the transcript", async () => {
    const { session, path } = await seed();
    await pinCommand(parseArgs(["pin", ID]), deps(session));

    await writeFile(path, `${await readFile(path, "utf8")}{"type":"mode","mode":"plan"}\n`);
    const info = await stat(path);
    const moved: Session = { ...session, sizeBytes: info.size, updatedAt: info.mtime };

    const out = captureOut();
    expect(await pinCommand(parseArgs(["pin", ID]), deps(moved))).toBe(0);
    expect(out.join("")).toMatch(/Archive refreshed/);

    const archive = await readArchive(home(), ID);
    expect(await readFile(archive?.transcriptPath ?? "", "utf8")).toContain("plan");
  });

  it("says plainly that a session is NOT protected when archiving fails", async () => {
    const { session, path } = await seed();
    await writeFile(path, "not json at all\n");
    const errors: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((c) => (errors.push(String(c)), true));

    const code = await pinCommand(parseArgs(["pin", ID]), deps(session));
    expect(code).toBe(1);
    expect(errors.join("")).toMatch(/NOT protected from Claude cleanup/);

    // The pin is recorded, but never as protection.
    const metadata = await readMetadata(home());
    expect(metadata.sessions[ID]?.pinned).toBe(true);
    expect(metadata.sessions[ID]?.protectionState).toBe("protected-stale");
  });
});

describe("unpinCommand", () => {
  it("keeps the archive and says so", async () => {
    const { session } = await seed();
    await pinCommand(parseArgs(["pin", ID]), deps(session));
    const out = captureOut();

    expect(await unpinCommand(parseArgs(["unpin", ID]), deps(session))).toBe(0);
    expect(out.join("")).toMatch(/unpinned/);
    expect(out.join("")).toMatch(/archive was kept/);
    expect(await readArchive(home(), ID)).toBeDefined();

    const metadata = await readMetadata(home());
    expect(metadata.sessions[ID]?.pinned).toBe(false);
  });

  it("is a no-op on a session that was never pinned", async () => {
    const { session } = await seed();
    const out = captureOut();
    expect(await unpinCommand(parseArgs(["unpin", ID]), deps(session))).toBe(0);
    expect(out.join("")).toMatch(/not pinned/);
  });
});

describe("metadata durability", () => {
  it("refuses to silently reset a metadata file it cannot parse", async () => {
    await writeFile(metadataFile(home()), "{ broken");
    await expect(readMetadata(home())).rejects.toThrow(/not valid JSON/);
  });
});

describe("protectionState", () => {
  const manifest = {
    schemaVersion: 1 as const,
    sessionId: ID,
    claudeVersions: [],
    sourcePath: "/x",
    archivedAt: NOW.toISOString(),
    sourceMtime: NOW.toISOString(),
    transcriptSha256: "abc",
    transcriptSizeBytes: 100,
  };

  it("is unprotected when not pinned, whatever archives exist", () => {
    expect(protectionState({ pinned: false, manifest })).toBe("unprotected");
  });

  it("is stale when pinned with no archive at all", () => {
    // Section 12 marks a missing archive with the same hollow star as a stale
    // one: in both cases the session is not actually preserved.
    expect(protectionState({ pinned: true })).toBe("protected-stale");
  });

  it("is current when the archive matches the live transcript", () => {
    expect(
      protectionState({ pinned: true, manifest, live: { sizeBytes: 100, mtime: NOW } }),
    ).toBe("protected-current");
  });

  it("is stale as soon as the transcript grows or moves", () => {
    expect(
      protectionState({ pinned: true, manifest, live: { sizeBytes: 101, mtime: NOW } }),
    ).toBe("protected-stale");
    expect(
      protectionState({
        pinned: true,
        manifest,
        live: { sizeBytes: 100, mtime: new Date(NOW.getTime() + 1000) },
      }),
    ).toBe("protected-stale");
  });

  it("stays current when Claude has swept the transcript and only the archive is left", () => {
    // No live transcript to fall behind: the archive is the session now.
    expect(protectionState({ pinned: true, manifest })).toBe("protected-current");
  });
});

describe("pinning a live session", () => {
  it("says the archive is only a snapshot", async () => {
    const { session } = await seed();
    const out = captureOut();
    await pinCommand(parseArgs(["pin", ID]), deps({ ...session, isLive: true }));
    expect(out.join("")).toMatch(/snapshot as of now/);
  });
});
