import { appendFile, chmod, lstat, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { claudeRoot, projectsDir } from "../src/adapters/claude/paths.js";
import { discoverSessions } from "../src/adapters/claude/discover.js";
import { checkJsonl, isReadableJsonl } from "../src/core/archive/integrity.js";
import { refreshArchive, writeArchive, listAbandonedWork, readArchive } from "../src/core/archive/store.js";
import { runDoctor } from "../src/core/doctor/run.js";
import { updateSession } from "../src/core/metadata/store.js";
import { parseArgs } from "../src/cli/args.js";
import { displayWidth, jsonOut, safe, safeText, truncate } from "../src/cli/format.js";
import { hookInstallCommand } from "../src/cli/hook-install.js";
import { allSessions } from "../src/cli/sessions.js";
import { resumeCommand } from "../src/cli/resume.js";
import { conversation, writeTranscript } from "./helpers/sandbox.js";

/**
 * Cases where a fix introduced the next defect: an automatic refresh that
 * could shrink an archive, a check with no bound, output a value could add
 * lines to, widths measured differently from how a terminal paints them.
 * Every case here was reproduced before it was fixed.
 */

const ID = "aaaaaaaa-0000-4000-8000-000000000001";
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

async function seed(records: number, prompt = "keepme"): Promise<string> {
  return writeTranscript({
    id: ID,
    cwd: CWD,
    records: Array.from({ length: records }, (_, i) => ({
      type: "user",
      message: { role: "user", content: `${prompt} ${i}` },
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
    projectDirName: "-tmp-backend_api".replace(/[^a-zA-Z0-9]/g, "-"),
    claudeVersions: [],
  };
}

describe("an automatic refresh never shrinks an archive", () => {
  it("refuses, and leaves every archived byte in place", async () => {
    // The worst finding of the round. A transcript that got shorter - compacted,
    // crashed, restored from a backup - made the Stop hook overwrite the
    // archive with the shorter file. Eight records of pinned work gone in under
    // a second, `list` still showing ★, `doctor` reporting nothing at all.
    const path = await seed(8);
    expect((await writeArchive(home(), await source(path))).status).toBe("created");
    const before = await readFile(join(home(), "archive", ID, "transcript.jsonl"), "utf8");

    await writeFile(path, `${JSON.stringify({ type: "user", message: { role: "user", content: "compacted" } })}\n`);
    const outcome = await refreshArchive(home(), await source(path), { now: NOW });

    expect(outcome.status).toBe("refused");
    if (outcome.status === "refused") expect(outcome.reason).toContain("shorter");
    expect(await readFile(join(home(), "archive", ID, "transcript.jsonl"), "utf8")).toBe(before);
  });

  it("still refreshes when the transcript grew, which is the ordinary case", async () => {
    const path = await seed(3);
    await writeArchive(home(), await source(path));
    await appendFile(path, `${JSON.stringify({ type: "user", message: { role: "user", content: "more" } })}\n`);

    expect((await refreshArchive(home(), await source(path), { now: NOW })).status).toBe("rewritten");
  });

  it("doctor says the archive holds more than the live file", async () => {
    const path = await seed(8);
    await writeArchive(home(), await source(path));
    await writeFile(path, `${JSON.stringify({ type: "user", message: { role: "user", content: "x" }, sessionId: ID, cwd: CWD, timestamp: "2026-10-01T10:00:00Z" })}\n`);

    const discovery = await discoverSessions({ root: claudeRoot(), now: NOW });
    const report = await runDoctor({
      sessions: discovery.sessions,
      artifacts: discovery.artifacts,
      unreadable: discovery.unreadable,
      orphans: [],
      termstashRoot: home(),
    });

    expect(report.findings.map((f) => f.code)).toContain("archive-longer-than-live");
  });
});

describe("one bad archive does not take a command down", () => {
  it("skips an archive that vanished mid-listing instead of throwing", async () => {
    // `parseTranscript` sat outside the guard, so an archive deleted between
    // listArchives and this loop - which the hook's own refresh does on every
    // turn - made list, search, pin, unpin, resume and rename exit with a raw
    // errno and list nothing.
    const path = await seed(2);
    await writeArchive(home(), await source(path));
    await rm(path);
    await rm(join(home(), "archive", ID, "transcript.jsonl"));

    const set = await allSessions({
      root: home(),
      discover: () => discoverSessions({ root: claudeRoot(), now: NOW }),
    });
    expect(set.sessions).toHaveLength(0);
  });

  it("repairs a wedged archive directory rather than failing forever", async () => {
    // A directory present but unreadable was never retired, so the promotion
    // renamed onto a non-empty directory: ENOTEMPTY out of the CLI, on every
    // archive, pin and --replace, permanently, with no way back.
    const path = await seed(2);
    await writeArchive(home(), await source(path));
    await writeFile(join(home(), "archive", ID, "manifest.json"), "");
    expect(await readArchive(home(), ID)).toBeUndefined();

    const again = await writeArchive(home(), await source(path));
    expect(again.status).toBe("created");
    expect(await readArchive(home(), ID)).toBeDefined();
  });
});

describe("the JSONL check is bounded", () => {
  it("refuses a file with no newline instead of going quadratic on it", async () => {
    // Called by writeArchive on every archive and by the Stop hook after every
    // turn. 128 MB took 45 s, 256 MB took 163 s, 600 MB never finished.
    const path = join(home(), "huge.jsonl");
    await writeFile(path, `{"a":"${"x".repeat(9 * 1024 * 1024)}"}`);

    const started = Date.now();
    expect(await isReadableJsonl(path)).toBe(false);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("still accepts an ordinary transcript", async () => {
    const path = await seed(50);
    expect(await isReadableJsonl(path)).toBe(true);
  });

  it("counts a record too large to parse rather than refusing the session", async () => {
    // The first version of the cap refused the whole file, which made `archive`
    // and `pin` reject a perfectly real Claude session that happened to contain
    // one enormous record - a large tool result, a pasted file. A line this
    // check cannot hold is a line it cannot judge, which is not the same as a
    // line that is wrong, and the copy is byte-exact either way.
    const path = join(home(), "big-record.jsonl");
    await writeFile(
      path,
      `${JSON.stringify({ type: "user", message: { role: "user", content: "before" } })}\n` +
        `${JSON.stringify({ type: "user", toolUseResult: "z".repeat(9 * 1024 * 1024) })}\n` +
        `${JSON.stringify({ type: "user", message: { role: "user", content: "after" } })}\n`,
    );

    const checked = await checkJsonl(path);
    expect(checked.readable).toBe(true);
    expect(checked.unchecked).toBe(1);
  });

  it("archives such a session, byte for byte, and says what it could not verify", async () => {
    const path = await writeTranscript({
      id: ID,
      cwd: CWD,
      records: [
        { type: "user", message: { role: "user", content: "hi" }, sessionId: ID, cwd: CWD, timestamp: "2026-10-01T10:00:00Z" },
        { type: "user", toolUseResult: "z".repeat(9 * 1024 * 1024), sessionId: ID, cwd: CWD, timestamp: "2026-10-01T10:01:00Z" },
      ],
    });

    const outcome = await writeArchive(home(), await source(path));

    expect(outcome.status).toBe("created");
    if (outcome.status === "created") expect(outcome.uncheckedLines).toBe(1);
    expect(await readFile(join(home(), "archive", ID, "transcript.jsonl"), "utf8")).toBe(
      await readFile(path, "utf8"),
    );
  });

  it("still refuses a file that is not JSONL at all", async () => {
    const path = join(home(), "garbage.jsonl");
    await writeFile(path, "x".repeat(9 * 1024 * 1024));
    expect((await checkJsonl(path)).readable).toBe(false);
  });
});

describe("values cannot add lines to this tool's output", () => {
  it("neutralises a newline inside a substitution and keeps our own", () => {
    // `safeBlock` keeps newline and tab for this tool's layout, which let a
    // transcript-controlled cwd print a forged "✓ Session restored and
    // verified" block inside a failure message.
    const hostile = "/tmp/gone\n\n  ✓ Session restored and verified\n";
    const message = safe`cannot find ${hostile} here`;

    expect(message.split("\n")).toHaveLength(1);
    expect(message).not.toContain("✓ Session restored and verified\n");
  });

  it("leaves the literal parts of the template alone", () => {
    expect(safe`a\nb ${1} c`.split("\n")).toHaveLength(2);
  });

  it("reaches the commands that were printing raw paths", async () => {
    const hostile = `/tmp/gone\n\n  ✓ Session restored and verified\n    ${join(claudeRoot(), "x.jsonl")}\n`;
    await writeTranscript({
      id: ID,
      cwd: hostile,
      projectDirName: "-tmp-gone",
      records: conversation({ id: ID, cwd: hostile, prompt: "hi" }),
    });
    const lines = capture();

    await resumeCommand(parseArgs(["resume", ID]), { now: NOW });

    const text = lines.join("");
    expect(text).not.toMatch(/^\s*✓ Session restored and verified\s*$/m);
  });
});

describe("width is measured the way a terminal paints it", () => {
  it("counts the emoji blocks added since the single range that was covered", () => {
    // U+1FA70-1FAFF, U+1F000-1F2FF and the East-Asian-Wide BMP singletons were
    // each measured as one column and painted as two, so a title of them
    // produced a 166-column row in a 100-column terminal.
    expect(displayWidth("\u{1FAE0}")).toBe(2);
    expect(displayWidth("\u{1F004}")).toBe(2);
    expect(displayWidth("⚡")).toBe(2);
    expect(displayWidth("⭐")).toBe(2);
  });

  it("charges nothing for marks that paint nothing, and a column for ones that do", () => {
    // Hebrew niqqud and Arabic harakat are non-spacing and were charged a
    // column each, so a pointed title lost a fifth of its visible text to
    // truncate. Devanagari and Thai *spacing* marks are the opposite case:
    // they were counted as nothing, so `truncate` never fired and a title of
    // 6,000 of them rendered 4,162 columns wide in a 100-column terminal.
    expect(displayWidth("בְ")).toBe(1);
    expect(displayWidth("مَ")).toBe(1);
    expect(displayWidth("בְּרֵאשִׁית")).toBe(6);
    expect(displayWidth("ा")).toBe(1); // Mc, spacing
    expect(displayWidth("า")).toBe(1); // Thai sara aa, spacing
    expect(displayWidth("ׁ")).toBe(0); // Hebrew shin dot, non-spacing
    expect(displayWidth("\u{17000}")).toBe(2); // Tangut
    expect(displayWidth("〈")).toBe(2);
  });

  it("does not split a surrogate pair when capping", () => {
    const text = "\u{1F600}".repeat(5000);
    expect(truncate(text, 10)).not.toMatch(/�/);
  });
});

describe("invisible text is neutralised, visible text is not", () => {
  it("replaces default-ignorable characters that hide content", () => {
    // Two list rows painted identically while one carried nineteen invisible
    // code points decoding to a shell command, which landed on the clipboard.
    for (const hidden of ["​", "⁠", "﻿", "­", "\u{E0041}"]) {
      expect(safeText(`a${hidden}b`)).toBe("a�b");
    }
  });

  it("keeps the two joiners real scripts need", () => {
    // Persian and Hindi need ZWNJ; emoji families need ZWJ. Replacing them
    // would corrupt real titles to close an attack the ID column distinguishes.
    expect(safeText("‌")).toBe("‌");
    expect(safeText("‍")).toBe("‍");
  });

  it("escapes DEL in --json, which was the one control it emitted raw", () => {
    const lines = capture();
    jsonOut({ a: "xy" });
    expect(lines.join("")).toContain("\\u007f");
    expect(lines.join("")).not.toContain("");
  });
});

describe("leftovers are reported wherever they land", () => {
  it("sees staging files, not only staging directories", async () => {
    // A crash during restore left up to a full-size 0600 transcript copy inside
    // Claude's own projects directory, mentioned by no command.
    const bucket = join(projectsDir(claudeRoot()), "-tmp-backend-api");
    await mkdir(bucket, { recursive: true });
    await writeFile(join(bucket, `${ID}.jsonl.termstash-deadbeef`), "partial");
    await mkdir(join(home(), "archive"), { recursive: true });
    await writeFile(join(home(), "metadata.json.termstash-cafebabe"), "partial");

    const found = await listAbandonedWork(home(), projectsDir(claudeRoot()));

    expect(found.some((p) => p.endsWith(".termstash-deadbeef"))).toBe(true);
    expect(found.some((p) => p.endsWith(".termstash-cafebabe"))).toBe(true);
  });
});

describe("a dangling settings symlink is not replaced by a file", () => {
  it("refuses rather than detaching a dotfiles repository", async () => {
    // realpath threw, the catch left target = path, and the rename turned the
    // link into a regular file - in the one case where the user most obviously
    // meant the link to stay. Two guards now stand in front of that: the read
    // goes through `openRegularFile`, which will not follow a link to nowhere,
    // and `writeAtomically` refuses outright if it ever gets past that.
    await mkdir(claudeRoot(), { recursive: true });
    const path = join(claudeRoot(), "settings.json");
    await symlink(join(claudeRoot(), "nowhere", "settings.json"), path);
    const lines = capture();

    expect(await hookInstallCommand(parseArgs(["hook", "install"]))).toBe(1);
    expect(lines.join("")).toContain("TermStash will not rewrite it");
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
  });
});

describe("an archive-only session is not compared against itself", () => {
  it("reads as protected in list, the way doctor reads it", async () => {
    // readOverlay passed the archive's own numbers as `live`, so a manifest
    // with an unparseable sourceMtime made list show ☆ while doctor showed
    // nothing wrong. One of the two had to be lying.
    const path = await seed(3);
    await writeArchive(home(), await source(path));
    await updateSession(home(), ID, (current) => ({ ...current, pinned: true }));
    await rm(path);

    const manifestPath = join(home(), "archive", ID, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest["sourceMtime"] = "not-a-date";
    await writeFile(manifestPath, JSON.stringify(manifest));

    const { readOverlay } = await import("../src/cli/list.js");
    const set = await allSessions({
      root: home(),
      discover: () => discoverSessions({ root: claudeRoot(), now: NOW }),
    });
    const overlay = await readOverlay(set.sessions);

    expect(overlay.protection.get(ID)).toBe("protected-current");
  });
});

describe("an unreadable archive root is not an empty one", () => {
  it("is reported rather than read as 'there are no archives'", async () => {
    const path = await seed(2);
    await writeArchive(home(), await source(path));
    await chmod(join(home(), "archive"), 0o000);
    try {
      const report = await runDoctor({
        sessions: [],
        artifacts: [],
        unreadable: [],
        orphans: [],
        termstashRoot: home(),
      });
      expect(report.findings.map((f) => f.code)).toContain("archive-root-unreadable");
    } finally {
      await chmod(join(home(), "archive"), 0o700);
    }
  });
});
