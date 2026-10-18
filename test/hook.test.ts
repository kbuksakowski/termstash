import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { claudeRoot } from "../src/adapters/claude/paths.js";
import { readArchive, writeArchive } from "../src/core/archive/store.js";
import { updateSession } from "../src/core/metadata/store.js";
import { parseArgs } from "../src/cli/args.js";
import { hookInstallCommand } from "../src/cli/hook-install.js";
import { hookCommand } from "../src/cli/hook.js";
import { conversation, writeTranscript } from "./helpers/sandbox.js";
import { execFileSync } from "node:child_process";
import { hookCommandLine, installedHookCommands, shellQuote } from "../src/cli/hook-install.js";
import { mkdtemp, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";

const ID = "aaaaaaaa-0000-4000-8000-000000000001";
const CWD = "/tmp/backend_api";

function home(): string {
  const value = process.env["TERMSTASH_HOME"];
  if (value === undefined) throw new Error("TERMSTASH_HOME not set");
  return value;
}

/** Feed a SessionEnd payload the way Claude does: JSON on stdin. */
function withStdin(payload: unknown): void {
  const stream = new PassThrough();
  stream.end(typeof payload === "string" ? payload : JSON.stringify(payload));
  vi.spyOn(process, "stdin", "get").mockReturnValue(
    stream as unknown as typeof process.stdin,
  );
}

async function seed(): Promise<string> {
  return writeTranscript({
    id: ID,
    cwd: CWD,
    records: conversation({ id: ID, cwd: CWD, prompt: "fix the webhook" }),
  });
}

async function archiveIt(path: string): Promise<void> {
  const info = await stat(path);
  await writeArchive(home(), {
    sessionId: ID,
    sourcePath: path,
    sizeBytes: info.size,
    mtime: info.mtime,
    projectPath: CWD,
    projectDirName: "-tmp-backend-api",
    claudeVersions: ["2.1.269"],
  });
}

const payloadFor = (path: string) => ({
  session_id: ID,
  transcript_path: path,
  cwd: CWD,
  hook_event_name: "SessionEnd",
  reason: "prompt_input_exit",
});

describe("archive-refresh hook", () => {
  it("accepts the Stop event, which is what survives a killed terminal", async () => {
    const path = await seed();
    await archiveIt(path);
    await updateSession(home(), ID, (c) => ({ ...c, pinned: true }));
    await writeFile(path, `${await readFile(path, "utf8")}{"type":"mode","mode":"plan"}\n`);

    withStdin({ ...payloadFor(path), hook_event_name: "Stop", stop_reason: "end_turn" });
    expect(await hookCommand(parseArgs(["hook", "stop"]))).toBe(0);

    const archive = await readArchive(home(), ID);
    expect(await readFile(archive?.transcriptPath ?? "", "utf8")).toContain("plan");
  });

  it("rejects an event it does not handle", async () => {
    const errors: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((c) => (errors.push(String(c)), true));
    expect(await hookCommand(parseArgs(["hook", "pre-tool-use"]))).toBe(1);
    expect(errors.join("")).toMatch(/stop\|session-end/);
  });

  it("refreshes the archive of a pinned session whose transcript grew", async () => {
    const path = await seed();
    await archiveIt(path);
    await updateSession(home(), ID, (c) => ({ ...c, pinned: true }));
    await writeFile(path, `${await readFile(path, "utf8")}{"type":"mode","mode":"plan"}\n`);

    withStdin(payloadFor(path));
    expect(await hookCommand(parseArgs(["hook", "session-end"]))).toBe(0);

    const archive = await readArchive(home(), ID);
    expect(await readFile(archive?.transcriptPath ?? "", "utf8")).toContain("plan");
    expect(archive?.manifest.refreshCount).toBe(1);
  });

  it("ignores a session that is not pinned", async () => {
    const path = await seed();
    withStdin(payloadFor(path));
    expect(await hookCommand(parseArgs(["hook", "session-end"]))).toBe(0);
    // Archiving every session anyone happens to close is not what pin means.
    expect(await readArchive(home(), ID)).toBeUndefined();
  });

  it("does not copy again when the archive is already current", async () => {
    const path = await seed();
    await archiveIt(path);
    await updateSession(home(), ID, (c) => ({ ...c, pinned: true }));

    withStdin(payloadFor(path));
    await hookCommand(parseArgs(["hook", "session-end"]));
    expect((await readArchive(home(), ID))?.manifest.refreshCount).toBeUndefined();
  });

  it("never fails the exit, whatever the payload", async () => {
    // SessionEnd cannot block, and errors in someone's terminal on every quit
    // would be worse than useless.
    for (const payload of ["", "not json", "{}", { session_id: ID }, { transcript_path: "/nope" }]) {
      withStdin(payload);
      expect(await hookCommand(parseArgs(["hook", "session-end"]))).toBe(0);
    }
  });

  it("survives a transcript that no longer exists", async () => {
    await updateSession(home(), ID, (c) => ({ ...c, pinned: true }));
    withStdin(payloadFor("/definitely/not/here.jsonl"));
    expect(await hookCommand(parseArgs(["hook", "session-end"]))).toBe(0);
  });
});

describe("hook install", () => {
  const settingsPath = () => join(claudeRoot(), "settings.json");
  const out: string[] = [];
  const capture = () => {
    out.length = 0;
    vi.spyOn(process.stdout, "write").mockImplementation((c) => (out.push(String(c)), true));
  };

  it("registers both Stop and SessionEnd", async () => {
    // Stop carries the guarantee; SessionEnd catches the last turn of a clean
    // exit. Registering only SessionEnd would miss a killed terminal entirely.
    capture();
    expect(await hookInstallCommand(parseArgs(["hook", "install"]))).toBe(0);
    const settings = JSON.parse(await readFile(settingsPath(), "utf8"));
    expect(JSON.stringify(settings.hooks.Stop)).toContain("hook stop");
    expect(JSON.stringify(settings.hooks.SessionEnd)).toContain("hook session-end");
  });

  it("preserves settings it knows nothing about", async () => {
    await writeFile(
      settingsPath(),
      JSON.stringify({ theme: "dark", permissions: { defaultMode: "auto" }, hooks: { SessionStart: [{ matcher: "*" }] } }),
    );
    capture();
    await hookInstallCommand(parseArgs(["hook", "install"]));

    const settings = JSON.parse(await readFile(settingsPath(), "utf8"));
    expect(settings.theme).toBe("dark");
    expect(settings.permissions.defaultMode).toBe("auto");
    expect(settings.hooks.SessionStart).toHaveLength(1);
    expect(settings.hooks.SessionEnd).toHaveLength(1);
    expect(settings.hooks.Stop).toHaveLength(1);
  });

  it("is idempotent", async () => {
    capture();
    await hookInstallCommand(parseArgs(["hook", "install"]));
    await hookInstallCommand(parseArgs(["hook", "install"]));
    const settings = JSON.parse(await readFile(settingsPath(), "utf8"));
    expect(settings.hooks.SessionEnd).toHaveLength(1);
    expect(settings.hooks.Stop).toHaveLength(1);
    expect(out.join("")).toMatch(/already installed/);
  });

  it("removes only its own entry", async () => {
    capture();
    await hookInstallCommand(parseArgs(["hook", "install"]));
    const settings = JSON.parse(await readFile(settingsPath(), "utf8"));
    settings.hooks.SessionEnd.push({ matcher: "*", hooks: [{ type: "command", command: "someone-elses-tool" }] });
    await writeFile(settingsPath(), JSON.stringify(settings));

    await hookInstallCommand(parseArgs(["hook", "install", "--uninstall"]));
    const after = JSON.parse(await readFile(settingsPath(), "utf8"));
    expect(after.hooks.SessionEnd).toHaveLength(1);
    expect(JSON.stringify(after.hooks.SessionEnd)).toContain("someone-elses-tool");
  });

  it("rewrites an older command in place, so running install again is the fix", async () => {
    // What 0.3.1 and earlier wrote when termstash was on PATH: the command
    // that came back `command not found` from a Claude without it.
    const old = (sub: string) => [{ matcher: "*", hooks: [{ type: "command", command: `termstash hook ${sub} # termstash-hook`, timeout: 60 }] }];
    await writeFile(settingsPath(), JSON.stringify({ hooks: { Stop: old("stop"), SessionEnd: old("session-end") } }));
    capture();

    expect(await hookInstallCommand(parseArgs(["hook", "install"]))).toBe(0);
    const settings = JSON.parse(await readFile(settingsPath(), "utf8"));
    expect(settings.hooks.Stop).toHaveLength(1);
    expect(settings.hooks.Stop[0].hooks[0].command).toBe(hookCommandLine("stop", process.execPath, process.argv[1] ?? ""));
    expect(settings.hooks.Stop[0].hooks[0].timeout).toBe(60);
    expect(out.join("")).not.toMatch(/already installed/);
  });

  it("will not point the hook into npx's cache", async () => {
    const real = process.argv[1];
    process.argv[1] = "/Users/you/.npm/_npx/0123456789abcdef/node_modules/.bin/termstash";
    const errors: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((c) => (errors.push(String(c)), true));
    try {
      expect(await hookInstallCommand(parseArgs(["hook", "install"]))).toBe(1);
    } finally {
      process.argv[1] = real ?? "";
    }
    expect(errors.join("")).toMatch(/npm install -g termstash/);
    await expect(stat(settingsPath())).rejects.toThrow();
  });

  it("refuses to rewrite a settings file it cannot parse", async () => {
    await writeFile(settingsPath(), "{ broken json");
    const errors: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((c) => (errors.push(String(c)), true));

    expect(await hookInstallCommand(parseArgs(["hook", "install"]))).toBe(1);
    expect(errors.join("")).toMatch(/not valid JSON/);
    // Rewriting it would discard whatever the user had in there.
    expect(await readFile(settingsPath(), "utf8")).toBe("{ broken json");
  });
});

describe("the installed hook command is a shell command", () => {
  /**
   * Whatever `hook install` writes runs after every Claude turn. When the
   * binary is not on PATH the command embeds absolute paths, and those come
   * from the machine rather than from anything this tool controls — so they are
   * quoted such that a shell reads them as literal text and nothing else.
   */
  it.each([
    ["a plain path", "/usr/local/bin/node", "'/usr/local/bin/node'"],
    ["command substitution", "/home/a$(whoami)/node", "'/home/a$(whoami)/node'"],
    ["backticks", "/home/`id`/node", "'/home/`id`/node'"],
    ["a quote", "/we'ird/path", "'/we'\\''ird/path'"],
    ["a space", "/My Apps/node", "'/My Apps/node'"],
  ])("quotes %s so the shell cannot act on it", (_name, input, expected) => {
    expect(shellQuote(input)).toBe(expected);
  });

  it("runs termstash from PATH when it is there, and its own path when it is not", async () => {
    // Claude runs hooks through /bin/sh -c with its own PATH. Without the CLI
    // on it, the bare command was exit 127 after every turn.
    const line = hookCommandLine("stop", "/bin/echo", "fallback");
    const run = (path: string) => execFileSync("/bin/sh", ["-c", line], { encoding: "utf8", env: { PATH: path } });
    expect(run("/usr/bin:/bin")).toBe("fallback hook stop\n");

    const bin = await mkdtemp(join(tmpdir(), "termstash-path-"));
    await writeFile(join(bin, "termstash"), "#!/bin/sh\necho from-path \"$@\"\n");
    await chmod(join(bin, "termstash"), 0o755);
    expect(run(`${bin}:/usr/bin:/bin`)).toBe("from-path hook stop\n");
  });

  it("round-trips through a real shell unchanged", () => {
    for (const path of ["/home/a$(whoami)/x", "/we'ird/x", "/back`tick`/x", "/a b/x"]) {
      const out = execFileSync("/bin/sh", ["-c", `printf %s ${shellQuote(path)}`], {
        encoding: "utf8",
      });
      expect(out).toBe(path);
    }
  });
});

describe("installed hook commands, for doctor", () => {
  it("are the commands hook install wrote, and nothing else", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const path = join(claudeRoot(), "settings.json");
    await writeFile(path, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "someone-elses-tool" }] }] } }));
    await hookInstallCommand(parseArgs(["hook", "install"]));

    const commands = await installedHookCommands(path);
    expect(commands).toHaveLength(2);
    expect(commands.every((c) => c.endsWith("# termstash-hook"))).toBe(true);
  });
});
