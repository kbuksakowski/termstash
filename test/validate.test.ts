import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { claudeRoot } from "../src/adapters/claude/paths.js";
import { readArchive, writeArchive } from "../src/core/archive/store.js";
import { checkArchiveIdentity, checkManifest } from "../src/core/archive/manifest.js";
import { readMetadata, updateSession } from "../src/core/metadata/store.js";
import { metadataFile } from "../src/core/paths.js";
import { parseArgs, flagString } from "../src/cli/args.js";
import { bucketOf, hookCommand } from "../src/cli/hook.js";
import { hookInstallCommand } from "../src/cli/hook-install.js";
import { writeSettings, writeTranscript } from "./helpers/sandbox.js";

/**
 * The third primitive: one validator per concept, asked on both sides of the
 * boundary. Every case here is a place where the check stood on one side and
 * the operation on the other — the shape that produced a third of the closing
 * round's findings, and five of them on its own.
 */

const ID = "aaaaaaaa-0000-4000-8000-000000000001";
const CWD = "/tmp/backend_api";

function home(): string {
  const value = process.env["TERMSTASH_HOME"];
  if (value === undefined) throw new Error("TERMSTASH_HOME not set");
  return value;
}

async function seed(options: { dirName?: string } = {}): Promise<string> {
  return writeTranscript({
    id: ID,
    cwd: CWD,
    ...(options.dirName !== undefined ? { projectDirName: options.dirName } : {}),
    records: [
      {
        type: "user",
        message: { role: "user", content: "hello" },
        timestamp: "2026-10-01T10:00:00Z",
        sessionId: ID,
        cwd: CWD,
      },
    ],
  });
}

async function source(path: string) {
  return {
    sessionId: ID,
    sourcePath: path,
    sizeBytes: (await stat(path)).size,
    mtime: new Date("2026-10-01T10:00:00Z"),
    projectPath: CWD,
    claudeVersions: [],
  };
}

describe("write refuses what read would refuse", () => {
  it("will not store a project directory name the reader rejects", async () => {
    // `isSafeSegment` stood on the read side only: `parseManifest` refused an
    // unsafe name and `writeArchive` stored one without blinking, producing an
    // archive this tool would never read back.
    const path = await seed();
    const outcome = await writeArchive(home(), { ...await source(path), projectDirName: ".." });

    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") expect(outcome.reason).toContain("project directory name");
    expect(await readArchive(home(), ID)).toBeUndefined();
  });

  it("will not store a session id the reader rejects", async () => {
    const path = await seed();
    const outcome = await writeArchive(home(), {
      ...await source(path),
      sessionId: "../../etc/passwd",
    });

    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") expect(outcome.reason).toContain("is not a session id");
  });

  it("says why, rather than failing quietly", async () => {
    // A refusal nobody is told about is how a tool that promises preservation
    // stops preserving. Three of the earlier fixes traded a hole for a silence.
    const path = await seed();
    const outcome = await writeArchive(home(), { ...await source(path), projectDirName: "a/b" });

    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.reason).toContain("a/b");
      expect(outcome.reason).toContain("nothing was changed");
    }
  });

  it("still stores the names Claude actually produces", async () => {
    const path = await seed();
    const outcome = await writeArchive(home(), {
      ...await source(path),
      projectDirName: "-tmp-backend-api",
    });

    expect(outcome.status).toBe("created");
    expect((await readArchive(home(), ID))?.manifest.projectDirName).toBe("-tmp-backend-api");
  });

  it("checks the whole manifest with the function the reader uses", () => {
    // The guarantee is not "these two fields": it is that anything the reader
    // refuses, the writer refuses first. A field added to one side alone is
    // caught here.
    const good = {
      schemaVersion: 1,
      sessionId: ID,
      claudeVersions: [],
      sourcePath: "/x",
      archivedAt: "2026-10-01T10:00:00Z",
      sourceMtime: "2026-10-01T10:00:00Z",
      transcriptSha256: "abc",
      transcriptSizeBytes: 1,
    };
    expect(checkManifest(good).ok).toBe(true);
    expect(checkManifest({ ...good, transcriptSizeBytes: "1" }).ok).toBe(false);
    expect(checkManifest({ ...good, projectDirName: 7 }).ok).toBe(false);
    expect(checkManifest(null).ok).toBe(false);
  });

  it("names the reason instead of returning a bare no", () => {
    expect(checkArchiveIdentity(ID, undefined)).toBeUndefined();
    expect(checkArchiveIdentity("nope", undefined)).toContain("not a session id");
    expect(checkArchiveIdentity(ID, "..")).toContain("project directory name");
  });
});

describe("the hook does not create an archive the tool cannot read", () => {
  function withStdin(payload: unknown): void {
    const stream = new PassThrough();
    stream.end(JSON.stringify(payload));
    vi.spyOn(process, "stdin", "get").mockReturnValue(stream as unknown as typeof process.stdin);
  }

  it("normalises a transcript path whose parent component is ..", async () => {
    // `bucketOf` split the raw string, so `.../-tmp-x/sub/../<id>.jsonl` gave
    // the bucket name "..". The archive was unreadable, so the pinned session
    // stayed unprotected — rewritten identically after every assistant turn.
    await seed();
    const indirect = join(claudeRoot(), "projects", "-tmp-backend-api", "sub", "..", `${ID}.jsonl`);
    await updateSession(home(), ID, (current) => ({ ...current, pinned: true }));

    withStdin({ session_id: ID, transcript_path: indirect, cwd: CWD });
    await hookCommand(parseArgs(["hook", "stop"]));

    const archive = await readArchive(home(), ID);
    expect(archive).toBeDefined();
    expect(archive?.manifest.projectDirName).toBe("-tmp-backend-api");
  });

  it("reports no bucket rather than an unusable one", () => {
    // `projectDirName` is optional and restore falls back to `projectPath`, so
    // a missing bucket costs a little precision. A wrong one sends the restore
    // somewhere else entirely, and a refusal would mean this hook — which runs
    // after every assistant turn — silently never protects the session.
    expect(bucketOf("/tmp/-a-b/x.jsonl")).toBe("-a-b");
    expect(bucketOf("/tmp/-a-b/sub/../x.jsonl")).toBe("-a-b");
    expect(bucketOf("/tmp/-a-b/./x.jsonl")).toBe("-a-b");
    expect(bucketOf("/x.jsonl")).toBeUndefined();
  });
});

describe("removal mirrors matching", () => {
  function capture(): string[] {
    const lines: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((c) => (lines.push(String(c)), true));
    vi.spyOn(process.stderr, "write").mockImplementation((c) => (lines.push(String(c)), true));
    return lines;
  }

  it("takes out our hook and leaves the user's beside it", async () => {
    // `isOurs` matched one level deeper than the removal: the splice deleted
    // the whole entry, so a hook the user had put next to ours was destroyed —
    // and reported as "✓ Hook removed".
    await writeSettings({
      permissions: { allow: ["Bash(ls:*)"] },
      hooks: {
        Stop: [
          {
            matcher: "*",
            hooks: [
              { type: "command", command: "my-own-hook --run", timeout: 30 },
              { type: "command", command: "termstash hook stop # termstash-hook", timeout: 60 },
            ],
          },
        ],
      },
    });
    capture();

    expect(await hookInstallCommand(parseArgs(["hook", "install", "--uninstall"]))).toBe(0);

    const settings = JSON.parse(
      await readFile(join(claudeRoot(), "settings.json"), "utf8"),
    ) as Record<string, Record<string, unknown[]>>;
    const stop = settings["hooks"]?.["Stop"] as Array<{ hooks: Array<{ command: string }> }>;
    expect(stop).toHaveLength(1);
    expect(stop[0]?.hooks.map((h) => h.command)).toEqual(["my-own-hook --run"]);
    expect(settings["permissions"]).toEqual({ allow: ["Bash(ls:*)"] });
  });

  it("drops the entry when ours was the only hook in it", async () => {
    await writeSettings({
      hooks: {
        Stop: [
          {
            matcher: "*",
            hooks: [{ type: "command", command: "termstash hook stop # termstash-hook" }],
          },
        ],
      },
    });
    capture();

    expect(await hookInstallCommand(parseArgs(["hook", "install", "--uninstall"]))).toBe(0);

    const settings = JSON.parse(await readFile(join(claudeRoot(), "settings.json"), "utf8")) as {
      hooks?: Record<string, unknown>;
    };
    expect(settings.hooks?.["Stop"]).toBeUndefined();
  });

  it("leaves unrelated entries alone, whatever shape they are in", async () => {
    // The removal walks every entry now, so entries it does not understand
    // have to survive the walk: they are someone else's configuration, and an
    // uninstall is not a licence to tidy.
    await writeSettings({
      hooks: {
        Stop: [
          { matcher: "*", hooks: [{ type: "command", command: "unrelated" }] },
          7,
          { matcher: "*", hooks: [{ type: "command", command: "termstash hook stop # termstash-hook" }] },
        ],
      },
    });
    capture();

    expect(await hookInstallCommand(parseArgs(["hook", "install", "--uninstall"]))).toBe(0);

    const settings = JSON.parse(await readFile(join(claudeRoot(), "settings.json"), "utf8")) as {
      hooks: { Stop: unknown[] };
    };
    expect(settings.hooks.Stop).toEqual([
      { matcher: "*", hooks: [{ type: "command", command: "unrelated" }] },
      7,
    ]);
  });
});

describe("a metadata entry carries the id it is filed under", () => {
  it("rejects one that does not, instead of crashing a command", async () => {
    // Every optional field was validated and the one mandatory field was not:
    // {"ghost":{"pinned":true}} reached a caller with no id and took doctor
    // down with "Cannot read properties of undefined (reading 'slice')".
    await writeFile(
      metadataFile(home()),
      JSON.stringify({ schemaVersion: 1, sessions: { ghost: { pinned: true } } }),
    );

    const file = await readMetadata(home());
    expect(file.sessions["ghost"]).toBeUndefined();
    expect(file.rejected?.["ghost"]).toEqual({ pinned: true });
  });

  it("rejects one claiming to be a different session", async () => {
    await writeFile(
      metadataFile(home()),
      JSON.stringify({ schemaVersion: 1, sessions: { [ID]: { sessionId: "something-else" } } }),
    );

    const file = await readMetadata(home());
    expect(file.sessions[ID]).toBeUndefined();
    expect(file.rejected?.[ID]).toEqual({ sessionId: "something-else" });
  });

  it("stamps the id on write, so the writer cannot produce what the reader refuses", async () => {
    await updateSession(home(), ID, () => ({ sessionId: "wrong", pinned: true }));

    const file = await readMetadata(home());
    expect(file.sessions[ID]?.sessionId).toBe(ID);
    expect(file.rejected).toBeUndefined();
  });
});

describe("a value flag given no value is a mistake, not an absence", () => {
  it("refuses --cwd with nothing after it", () => {
    // `--cwd ""` was fixed and the sibling branch was left: the parser stored
    // `true`, flagString returned undefined, and resume started Claude in the
    // transcript's own project directory while the user believed otherwise.
    expect(() => flagString(parseArgs(["resume", ID, "--cwd"]), "cwd")).toThrow(/needs a value/);
  });

  it("refuses a value the parser read as the next flag", () => {
    expect(() => flagString(parseArgs(["resume", ID, "--cwd", "--json"]), "cwd")).toThrow(
      /needs a value/,
    );
  });

  it("says how to pass a value that begins with a dash", () => {
    expect(() => flagString(parseArgs(["list", "--project"]), "project")).toThrow(/--project=/);
    expect(flagString(parseArgs(["list", "--project=-weird"]), "project")).toBe("-weird");
  });

  it("still reads an ordinary value, and still means absent when absent", () => {
    expect(flagString(parseArgs(["list", "--project", "api"]), "project")).toBe("api");
    expect(flagString(parseArgs(["list"]), "project")).toBeUndefined();
  });

  it("does not disturb flags that never take one", () => {
    const args = parseArgs(["list", "--json", "--pinned"]);
    expect(args.flags.get("json")).toBe(true);
    expect(args.flags.get("pinned")).toBe(true);
  });
});
