import { appendFile, chmod, lstat, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { claudeRoot } from "../src/adapters/claude/paths.js";
import { discoverSessions } from "../src/adapters/claude/discover.js";
import { extendsArchive, readArchive, refreshArchive, writeArchive } from "../src/core/archive/store.js";
import { sha256File } from "../src/core/archive/integrity.js";
import { displayWidth, renderTable } from "../src/cli/format.js";
import { describeError } from "../src/core/text/safe.js";
import { runDoctor } from "../src/core/doctor/run.js";
import { readMetadata, updateSession } from "../src/core/metadata/store.js";
import { readHistory } from "../src/adapters/claude/history.js";
import { metadataFile } from "../src/core/paths.js";
import { parseArgs } from "../src/cli/args.js";
import { hookInstallCommand, isAsIntended } from "../src/cli/hook-install.js";
import { writeTranscript } from "./helpers/sandbox.js";

/**
 * The archive is often the only copy of a conversation, so every path that
 * replaces, repairs or retires one is tested here against the cases that
 * destroyed it: a guard asking a different question than the operation it
 * protects, a repair that ran before the rescue, and hardening that broke
 * legitimate setups such as a symlinked settings file.
 */

const ID = "11111111-1111-4111-8111-111111111111";
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

async function seed(count: number, tag: string): Promise<string> {
  return writeTranscript({
    id: ID,
    cwd: CWD,
    records: Array.from({ length: count }, (_, i) => ({
      type: "user",
      message: { role: "user", content: `${tag}-${i} irreplaceable padding` },
      timestamp: "2026-10-01T10:00:00Z",
      sessionId: ID,
      cwd: CWD,
    })),
  });
}

async function source(path: string) {
  const info = await stat(path);
  return {
    sessionId: ID,
    sourcePath: path,
    sizeBytes: info.size,
    mtime: info.mtime,
    projectPath: CWD,
    projectDirName: "-tmp-backend-api",
    claudeVersions: [],
  };
}

function archived(): string {
  return join(home(), "archive", ID, "transcript.jsonl");
}

describe("an archive this tool cannot read is still the user's only copy", () => {
  it("is set aside, not deleted, when the directory is repaired", async () => {
    // The self-repair added for the ENOTEMPTY wedge gated destruction on
    // `lstat` while every shrink guard stayed gated on `readArchive`
    // succeeding. So an unparseable manifest turned off every guard at once:
    // `hook stop`, `pin`, and `archive` *without* --replace each replaced an
    // intact eight-record transcript with a one-record one and reported
    // success - the shrink the guards exist to prevent, through the repair.
    const path = await seed(8, "original");
    await writeArchive(home(), await source(path));
    const before = await readFile(archived(), "utf8");
    expect(before).toContain("original-7");

    await writeFile(join(home(), "archive", ID, "manifest.json"), '{"schemaVersion":1,"ses');
    const tiny = await seed(1, "tiny");
    const outcome = await writeArchive(home(), await source(tiny));

    expect(outcome.status).toBe("created");
    const kept = outcome.status === "created" ? outcome.discarded?.quarantinedTo : undefined;
    expect(kept).toBeDefined();
    expect(await readFile(join(kept ?? "", "transcript.jsonl"), "utf8")).toBe(before);
  });

  it("keeps the retired directory when the replacement is not a superset", async () => {
    const path = await seed(8, "original");
    await writeArchive(home(), await source(path));
    await writeFile(join(home(), "archive", ID, "manifest.json"), "{");

    await writeArchive(home(), await source(await seed(1, "tiny")));

    const { listAbandonedWork } = await import("../src/core/archive/store.js");
    expect(await listAbandonedWork(home())).not.toHaveLength(0);
  });
});

describe("the question is whether the live file still extends the archive", () => {
  it("refuses a rewritten history even once it has grown past the old length", async () => {
    // The first guard compared sizes. `/compact` makes the transcript shorter,
    // the size guard refuses for a turn or two, and then the session grows
    // back past the old byte count and the guard waves through a replacement
    // that discards every pre-compaction record. The delay made it look safe;
    // it only moved the loss.
    const path = await seed(8, "precompact");
    await writeArchive(home(), await source(path));

    await writeFile(path, `${JSON.stringify({ type: "user", message: { role: "user", content: "compacted" } })}\n`);
    for (let turn = 0; turn < 5; turn += 1) {
      await appendFile(
        path,
        `${JSON.stringify({ type: "user", message: { role: "user", content: `post-${turn} padding padding padding` } })}\n`.repeat(6),
      );
      await refreshArchive(home(), await source(path), { now: NOW });
    }

    expect((await stat(path)).size).toBeGreaterThan((await stat(archived())).size);
    expect(await readFile(archived(), "utf8")).toContain("precompact-7");
  });

  it("refuses a rewrite that lands on the same byte count", async () => {
    const path = await seed(6, "original");
    await writeArchive(home(), await source(path));
    const size = (await stat(path)).size;

    // Same length to the byte: "original" and "REWRITTE" are both eight
    // characters, so only the content differs.
    const rewritten = (await readFile(path, "utf8")).replace(/original/g, "REWRITTE");
    await writeFile(path, rewritten);
    expect((await stat(path)).size).toBe(size);

    const outcome = await refreshArchive(home(), await source(path), { now: NOW });
    expect(outcome.status).toBe("refused");
    expect(await readFile(archived(), "utf8")).toContain("original-5");
  });

  it("still refreshes an ordinary append", async () => {
    const path = await seed(4, "original");
    await writeArchive(home(), await source(path));
    await appendFile(path, `${JSON.stringify({ type: "user", message: { role: "user", content: "more" } })}\n`);

    expect((await refreshArchive(home(), await source(path), { now: NOW })).status).toBe("rewritten");
  });

  it("tells a deleted transcript apart from a diverged one", async () => {
    const path = await seed(4, "original");
    await writeArchive(home(), await source(path));
    const archive = await readArchive(home(), ID);
    const src = await source(path);
    await rm(path);

    expect(await extendsArchive(path, archive?.manifest ?? ({} as never))).toBe("unreadable");
    expect((await refreshArchive(home(), { ...src, sizeBytes: src.sizeBytes + 10 })).status).toBe(
      "failed",
    );
  });

  it("doctor names the rewrite and explains the pin with it", async () => {
    const path = await seed(8, "precompact");
    await writeArchive(home(), await source(path));
    await updateSession(home(), ID, (current) => ({ ...current, pinned: true }));
    const rewritten = Array.from({ length: 20 }, (_, i) =>
      JSON.stringify({ type: "user", message: { role: "user", content: `after-${i} padding padding padding` }, sessionId: ID, cwd: CWD, timestamp: "2026-10-02T10:00:00Z" }),
    ).join("\n");
    await writeFile(path, `${rewritten}\n`);

    const discovery = await discoverSessions({ root: claudeRoot(), now: NOW });
    const report = await runDoctor({
      sessions: discovery.sessions,
      artifacts: discovery.artifacts,
      unreadable: discovery.unreadable,
      orphans: [],
      termstashRoot: home(),
    });

    expect(report.findings.map((f) => f.code)).toContain("archive-history-rewritten");
    const protection = report.findings.find((f) => f.code === "pinned-not-protected");
    expect(protection?.details.join(" ")).toContain("the transcript was rewritten");
    expect(protection?.details.join(" ")).not.toContain("archive is behind");
  });
});

describe("a file the user may legitimately symlink is followed, not refused", () => {
  it("installs the hook through a symlinked settings.json and keeps the link", async () => {
    // `O_NOFOLLOW` is right for a path this tool chose and wrong for one the
    // user owns. Applying it to settings.json made `hook install` refuse
    // outright, and a dotfiles repository is the common layout here.
    await mkdir(join(claudeRoot(), "dotfiles"), { recursive: true });
    const real = join(claudeRoot(), "dotfiles", "settings.json");
    await writeFile(real, JSON.stringify({ permissions: { allow: ["Bash(ls:*)"] } }));
    await symlink(real, join(claudeRoot(), "settings.json"));
    capture();

    expect(await hookInstallCommand(parseArgs(["hook", "install"]))).toBe(0);

    const written = JSON.parse(await readFile(real, "utf8")) as Record<string, unknown>;
    expect(written["hooks"]).toBeDefined();
    expect(written["permissions"]).toEqual({ allow: ["Bash(ls:*)"] });
  });

  it("reads and writes metadata through a symlink without replacing it", async () => {
    // The read side returned an empty file, so every pin vanished and the hook
    // stopped archiving without a word; the write side then renamed over the
    // link, taking the real file's other entries with it.
    const real = join(home(), "real-metadata.json");
    await writeFile(
      real,
      JSON.stringify({ schemaVersion: 1, sessions: { keep: { sessionId: "keep", title: "PRECIOUS" } } }),
    );
    await symlink(real, metadataFile(home()));

    await updateSession(home(), ID, (current) => ({ ...current, pinned: true }));

    const file = await readMetadata(home());
    expect(file.sessions[ID]?.pinned).toBe(true);
    expect(await readFile(real, "utf8")).toContain("PRECIOUS");
  });
});

describe("a transcript being written to is copied as a prefix", () => {
  it("hashes exactly what it copied, so a concurrent append does not fail the refresh", async () => {
    // The copy was taken, then the *source* was hashed again — and it had
    // grown. At 50 MB the refresh failed 8 times out of 8, the hook threw the
    // reason away, and the busiest pinned sessions stopped being archived.
    const path = await seed(200, "original");
    const src = await source(path);
    await appendFile(path, `${JSON.stringify({ type: "user", message: { role: "user", content: "arrived mid-copy" } })}\n`);

    const outcome = await writeArchive(home(), src);

    expect(outcome.status).toBe("created");
    expect(await readFile(archived(), "utf8")).not.toContain("arrived mid-copy");
    expect((await stat(archived())).size).toBe(src.sizeBytes);
  });
});

/**
 * The same defect in several disguises: a guard on one predicate and the
 * operation on another. Every caller now asks `extendsArchive`, and these
 * pin that down.
 */
describe("the recovery command the tool prints must not destroy anything", () => {
  it("quarantines when the replacement does not contain the archive, however long it is", async () => {
    // `pin` refuses on the prefix test and then printed `archive --replace`
    // promising "keeping the longer one in quarantine". The quarantine was
    // gated on size, and after a /compact the live file is longer - so the
    // command the tool recommended deleted the archive it had just protected.
    const path = await seed(8, "zebrafish");
    await writeArchive(home(), await source(path));
    // Deliberately LONGER than the archive: that is the /compact case, and the
    // case the size-based quarantine let through.
    const rewritten = Array.from({ length: 40 }, (_, i) =>
      JSON.stringify({
        type: "user",
        message: { role: "user", content: `after-${i} padding padding padding padding` },
        timestamp: "2026-10-02T10:00:00Z",
        sessionId: ID,
        cwd: CWD,
      }),
    ).join("\n");
    await writeFile(path, `${rewritten}\n`);
    expect((await stat(path)).size).toBeGreaterThan(
      (await stat(join(home(), "archive", ID, "transcript.jsonl"))).size,
    );

    const outcome = await writeArchive(home(), await source(path), { replace: true });

    expect(outcome.status).toBe("refreshed");
    const kept = outcome.status === "refreshed" ? outcome.discarded : undefined;
    expect(kept?.why).toBe("rewritten");
    expect(await readFile(join(kept?.quarantinedTo ?? "", "transcript.jsonl"), "utf8")).toContain(
      "zebrafish-7",
    );
  });

  it("still deletes the retired copy when the replacement really does contain it", async () => {
    const path = await seed(4, "original");
    await writeArchive(home(), await source(path));
    await appendFile(path, `${JSON.stringify({ type: "user", message: { role: "user", content: "more" } })}\n`);

    const outcome = await writeArchive(home(), await source(path), { replace: true });
    expect(outcome.status).toBe("refreshed");
    if (outcome.status === "refreshed") expect(outcome.discarded).toBeUndefined();
  });
});

describe("a guard that cannot answer is not a yes", () => {
  it("refuses when the prefix check cannot be made at all", async () => {
    // limit === 0 became createReadStream({end: -1}), which throws;
    // extendsArchive caught it as "unreadable", and pin tested only for "no" -
    // so a crashed guard read as permission and the archive was overwritten.
    const path = await seed(8, "record");
    await writeArchive(home(), await source(path));
    const manifestPath = join(home(), "archive", ID, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest["transcriptSizeBytes"] = 0;
    await writeFile(manifestPath, JSON.stringify(manifest));

    const archive = await readArchive(home(), ID);
    expect(archive).toBeDefined();
    expect(await extendsArchive(path, archive?.manifest ?? ({} as never))).toBe("no");
  });

  it("hashes zero bytes rather than throwing", async () => {
    const path = await seed(2, "x");
    expect(await sha256File(path, 0)).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("tells a shorter transcript apart from a diverged one", async () => {
    const path = await seed(8, "original");
    await writeArchive(home(), await source(path));
    const archive = await readArchive(home(), ID);
    const whole = await readFile(path, "utf8");
    await writeFile(path, whole.split("\n").slice(0, 3).join("\n") + "\n");

    expect(await extendsArchive(path, archive?.manifest ?? ({} as never))).toBe("shorter");
  });
});

describe("measuring and truncating walk the text the same way", () => {
  it("counts an emoji presentation sequence as the two columns it paints", () => {
    // displayWidth learned the lookahead; truncate kept asking one character
    // at a time, where a lookahead can see nothing. The 166-column row came
    // back through the half of the fix that was not made.
    expect(displayWidth("❤️")).toBe(2);
    expect(displayWidth("1️⃣")).toBe(2);
    expect(displayWidth("\u{18D00}")).toBe(2);
    expect(displayWidth("\u{16FE0}")).toBe(2);
  });

  it("keeps a row of them inside the terminal", () => {
    const rows = [[" ", "aaaaaa", "p", "now", "❤️".repeat(4000)]];
    for (const line of renderTable(
      [
        { header: "", min: 2 },
        { header: "ID", min: 6 },
        { header: "PROJECT", min: 8 },
        { header: "UPDATED", min: 9 },
        { header: "SESSION", flex: 1, min: 20 },
      ],
      rows,
      100,
    )) {
      expect(displayWidth(line)).toBeLessThanOrEqual(100);
    }
  });
});

describe("an errno is text about someone else's filesystem", () => {
  it("cannot carry a newline into a message", () => {
    const hostile = new Error("EACCES: permission denied, open '/p\n✓ Session restored and verified\nx'");
    expect(describeError(hostile).split("\n")).toHaveLength(1);
  });
});

describe("a file the tool cannot read is not an empty one", () => {
  it("refuses rather than overwriting metadata it could not open", async () => {
    // `openUserFile` collapsed missing, not-a-regular-file and permission
    // denied into one answer, and the caller read that as "empty" and wrote it
    // back: every pin and every title gone, under "✓ Session pinned".
    //
    // The first attempt at this guard threw from inside the try block whose
    // catch returns an empty file — so the throw meant to protect the pins was
    // swallowed by the handler it was written to replace, and the wipe
    // continued. The guard is outside that block now.
    await updateSession(home(), ID, (current) => ({ ...current, title: "KEEPME" }));
    await chmod(metadataFile(home()), 0o000);

    try {
      await expect(readMetadata(home())).rejects.toThrow(/could not be read/);
    } finally {
      await chmod(metadataFile(home()), 0o600);
    }
    expect((await readMetadata(home())).sessions[ID]?.title).toBe("KEEPME");
  });

  it("still treats a genuinely absent file as empty", async () => {
    await rm(metadataFile(home()), { force: true });
    expect((await readMetadata(home())).sessions).toEqual({});
  });

  it("will not replace a metadata symlink whose target is gone", async () => {
    // Two guards stand in front of this now and the read one answers first:
    // a dangling link is a file that exists and cannot be opened. What matters
    // is that the link is still a link afterwards - `writeMetadata` used to
    // rename straight over it, detaching a dotfiles repository.
    await rm(metadataFile(home()), { force: true });
    await symlink(join(home(), "nowhere", "metadata.json"), metadataFile(home()));

    await expect(
      updateSession(home(), ID, (current) => ({ ...current, pinned: true })),
    ).rejects.toThrow(/could not be read|will not replace the link/);
    expect((await lstat(metadataFile(home()))).isSymbolicLink()).toBe(true);
  });
});

describe("history that could not be read is not history that held nothing", () => {
  it("reports the failure instead of counting it as no evidence", async () => {
    const path = join(claudeRoot(), "history.jsonl");
    await writeFile(path, `${JSON.stringify({ sessionId: ID, display: "gone work", timestamp: Date.now() })}\n`);
    await chmod(path, 0o000);

    try {
      const scan = await readHistory(claudeRoot());
      expect(scan.unreadable).toBeDefined();
      expect(scan.sessions).toHaveLength(0);
    } finally {
      await chmod(path, 0o600);
    }
  });

  it("says nothing when there is simply no history file", async () => {
    expect((await readHistory(claudeRoot())).unreadable).toBeUndefined();
  });
});

describe("hook install verifies its own work", () => {
  it("re-applies the edit when another writer lands on top of it", async () => {
    // There is no lock to take: the competitor is Claude Code doing its own
    // read-modify-write, and it will never honour a lockfile of ours. Reading
    // the file back and looking is what works against any writer — the edit is
    // additive and idempotent, so redoing it on their version is right.
    await mkdir(claudeRoot(), { recursive: true });
    const path = join(claudeRoot(), "settings.json");
    await writeFile(path, JSON.stringify({ permissions: { allow: ["Bash(ls:*)"] } }));
    capture();

    expect(await hookInstallCommand(parseArgs(["hook", "install"]))).toBe(0);

    const settings = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    expect(settings["hooks"]).toBeDefined();
    expect(settings["permissions"]).toEqual({ allow: ["Bash(ls:*)"] });
    expect(await isAsIntended(path, false)).toBe(true);
  });

  it("knows when the file does not say what it set out to say", async () => {
    await mkdir(claudeRoot(), { recursive: true });
    const path = join(claudeRoot(), "settings.json");
    await writeFile(path, JSON.stringify({ hooks: { Stop: [{ matcher: "*", hooks: [] }] } }));

    expect(await isAsIntended(path, false)).toBe(false);
    expect(await isAsIntended(path, true)).toBe(true);
  });

  it("doctor says so when a pinned session has no hook behind it", async () => {
    // The window this cannot close: a writer that commits after our process
    // exits. Nothing in the report ever read settings.json, so the only
    // symptom was the star going hollow, which looks like ordinary staleness.
    const path = await seed(3, "x");
    await writeArchive(home(), await source(path));
    await updateSession(home(), ID, (current) => ({ ...current, pinned: true }));

    const discovery = await discoverSessions({ root: claudeRoot(), now: NOW });
    const report = await runDoctor({
      sessions: discovery.sessions,
      artifacts: discovery.artifacts,
      unreadable: discovery.unreadable,
      orphans: [],
      termstashRoot: home(),
      hookInstalled: false,
    });

    expect(report.findings.map((f) => f.code)).toContain("hook-not-installed");
  });
});
