import { randomBytes } from "node:crypto";
import { describeError } from "../core/text/safe.js";
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { claudeRoot } from "../adapters/claude/paths.js";
import { openUserFile } from "../core/fs/user-file.js";
import type { ParsedArgs } from "./args.js";
import { flagBool } from "./args.js";
import { err, out, safe } from "./format.js";

/**
 * What identifies our entry in someone's settings file.
 *
 * Deliberately the command's tail rather than the word "termstash": an
 * installed package runs from `.../dist/cli.js`, which does not contain the
 * package name, and matching on it made install non-idempotent.
 */
const MARKER = "termstash-hook";

/**
 * Two events, for two failure modes.
 *
 * `Stop` fires after every assistant turn and is what makes the guarantee
 * hold: `SessionEnd` does not run when a terminal is killed or Claude crashes,
 * which is the case this product exists for. `SessionEnd` still catches the
 * final turn of a clean exit.
 */
const EVENTS = ["Stop", "SessionEnd"] as const;

/** POSIX single-quoting: nothing inside survives as anything but literal text. */
export function shellQuote(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`;
}

/**
 * Wire the Stop and SessionEnd hooks into Claude's settings. PRD v0.2 section 32.
 *
 * settings.json is the user's file and may hold hooks, permissions and
 * env this tool knows nothing about, so every edit here is additive, checked
 * for an existing entry first, and written through a temp file and a rename.
 */
type Attempt =
  | { kind: "refused"; message: string }
  | { kind: "unchanged" }
  | { kind: "written" };

/**
 * Write the hook into someone else's settings file and then check it is there.
 *
 * There is no lock to take. The competitor is Claude Code itself, doing its
 * own read-modify-write, and it will never honour a lockfile of ours - so a
 * lock would serialise this tool against itself and do nothing about the race
 * that actually happens. Measured: a writer landing 15 ms or more after this
 * starts removes our entry 9 times in 10, and "✓ Hook installed" was printed
 * anyway.
 *
 * What works against any writer is to read the file back and look. If our
 * entry is not there, someone wrote over us between our read and our rename;
 * the edit is additive and idempotent, so doing it again on their version is
 * exactly right. After a few attempts, say so rather than claiming success -
 * a hook that is not installed is a pinned session that silently stops being
 * refreshed.
 */
const WRITE_ATTEMPTS = 5;

export async function hookInstallCommand(args: ParsedArgs): Promise<number> {
  const remove = flagBool(args, "uninstall");
  const path = join(claudeRoot(), "settings.json");

  for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt += 1) {
    const result = await attemptEdit(path, remove);
    if (result.kind === "refused") return fail(result.message);
    if (result.kind === "unchanged") {
      out(
        remove
          ? "The TermStash hook is not installed. Nothing to do.\n"
          : safe`The TermStash hook is already installed in ${path}\n`,
      );
      return 0;
    }

    if (await isAsIntended(path, remove)) {
      if (remove) {
        out(
          safe`✓ Hook removed from ${path}\n  Pinned sessions will no longer be archived automatically.\n`,
        );
        return 0;
      }
      out(
        safe`✓ Hook installed in ${path}\n\n` +
          "  A pinned session's archive is now refreshed after each turn and when the\n" +
          "  session ends. Sessions you have not pinned are untouched.\n\n" +
          "  Remove it with: termstash hook install --uninstall\n",
      );
      return 0;
    }
    // Someone wrote over us. Give them a moment and redo the edit on top of
    // whatever they left.
    await new Promise((r) => setTimeout(r, 20 + Math.floor(Math.random() * 60)));
  }

  return fail(
    safe`${path} is being written by something else; TermStash's change did not survive ${WRITE_ATTEMPTS} attempts.\n` +
      "Close whatever is editing it and run this again. Nothing of yours was lost.",
  );
}

/** True when the file on disk now says what this command set out to make it say. */
export async function isAsIntended(path: string, remove: boolean): Promise<boolean> {
  const handle = await openUserFile(path);
  if (handle === undefined) return remove;
  let raw: string;
  try {
    raw = await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  const hooks = asRecord((parsed as Record<string, unknown>)["hooks"]);
  const present = EVENTS.every((event) => {
    const entries = hooks[event];
    return Array.isArray(entries) && entries.some((entry) => isOurs(entry, event));
  });
  const absent = EVENTS.every((event) => {
    const entries = hooks[event];
    return !Array.isArray(entries) || !entries.some((entry) => isOurs(entry, event));
  });
  return remove ? absent : present;
}

async function attemptEdit(path: string, remove: boolean): Promise<Attempt> {

  let raw: string | undefined;
  try {
    // `openRegularFile` rather than `readFile`: a FIFO at settings.json parked
    // this inside open() forever, and the process could not even exit. That is
    // the rule the archive layer already follows; this read was outside it.
    const handle = await openUserFile(path);
    if (handle === undefined) {
      const exists = await lstat(path).then(() => true).catch(() => false);
      if (exists) {
        return { kind: "refused", message: safe`${path} is not an ordinary file. TermStash will not rewrite it.` };
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    }
    try {
      raw = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    // Only "there is no file" means start from nothing. Every other errno -
    // no permission, a file too large for V8 to hold as a string, I/O failure -
    // used to be read as absence, and the next write replaced a settings file
    // holding permissions, env and secrets with four lines, reporting success.
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      return {
        kind: "refused",
        message:
          safe`${path} could not be read (${code ?? describeError(error)}). ` +
          "TermStash will not rewrite a file it cannot see.",
      };
    }
    raw = undefined;
  }

  let settings: Record<string, unknown>;
  if (raw === undefined) {
    settings = {};
  } else {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return { kind: "refused", message: safe`${path} is not a JSON object. TermStash will not rewrite it.` };
      }
      settings = parsed as Record<string, unknown>;
    } catch {
      // Rewriting a file we could not parse would discard whatever is in it.
      return { kind: "refused", message: safe`${path} is not valid JSON. TermStash will not rewrite it — fix the file first.` };
    }
  }

  // Prefer the bare command when the binary is on PATH: it survives a version
  // upgrade that moves the install directory. Fall back to an absolute path.
  //
  // Whatever goes in here is a shell command Claude runs after every turn, so
  // the paths are single-quoted rather than JSON-quoted. Double quotes still
  // expand `$(...)`, backticks and `\`, and an install path is not something
  // this tool gets to assume is well behaved.
  const base = onPath()
    ? "termstash"
    : `${shellQuote(process.execPath)} ${shellQuote(process.argv[1] ?? "")}`;

  // "Additive" has to mean it. A hooks field of an unexpected shape is someone
  // else's configuration, and quietly dropping it is the one thing this edit
  // promised not to do.
  const existingHooks = settings["hooks"];
  if (existingHooks !== undefined && !isPlainObject(existingHooks)) {
    return { kind: "refused", message: safe`${path} has a "hooks" field that is not an object. TermStash will not rewrite it.` };
  }
  const hooks = asRecord(existingHooks);
  let changed = false;

  for (const event of EVENTS) {
    const existingEntries = hooks[event];
    if (existingEntries !== undefined && !Array.isArray(existingEntries)) {
      return { kind: "refused", message: safe`${path} has a "hooks.${event}" field that is not an array. TermStash will not rewrite it.` };
    }
    const entries = Array.isArray(existingEntries) ? [...existingEntries] : [];
    // Match our own command, not any text containing the word. Searching the
    // whole serialised entry claimed a user hook that merely mentioned
    // "termstash-hook" - install then skipped, and uninstall deleted it.
    const mine = entries.findIndex((entry) => isOurs(entry, event));

    if (remove) {
      if (mine === -1) continue;
      // Removal mirrors matching, one level deep. `isOurs` looks inside
      // `entry.hooks` for our command and the removal deleted the whole entry,
      // so a user who had put their own hook beside ours in the same entry
      // lost it - and was told "✓ Hook removed".
      const kept = entries.flatMap((entry) => {
        const remainder = withoutOurs(entry, event);
        return remainder === undefined ? [] : [remainder];
      });
      changed = true;
      if (kept.length === 0) delete hooks[event];
      else hooks[event] = kept;
      continue;
    }

    if (mine !== -1) continue;
    entries.push({
      matcher: "*",
      hooks: [
        {
          type: "command",
          command: `${base} hook ${event === "Stop" ? "stop" : "session-end"} # termstash-hook`,
          timeout: 60,
        },
      ],
    });
    hooks[event] = entries;
    changed = true;
  }

  if (!changed) return { kind: "unchanged" };

  if (Object.keys(hooks).length === 0) delete settings["hooks"];
  else settings["hooks"] = hooks;

  await writeAtomically(path, settings);
  return { kind: "written" };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

async function writeAtomically(path: string, settings: unknown): Promise<void> {
  await mkdir(claudeRoot(), { recursive: true });

  // A rename replaces the inode, so the new file carries the umask rather than
  // whatever the old one had. settings.json holds `env` and `apiKeyHelper`,
  // so widening 0600 to 0644 hands those to every account on the machine.
  let mode = 0o600;
  // Following a symlink matters more than the mode: ~/.claude/settings.json is
  // very often a link into a dotfiles repository, and a rename would quietly
  // turn it into an ordinary file, detaching it from its source of truth.
  let target = path;
  let link: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    link = await lstat(path);
  } catch {
    // No file yet. 0600 is the right default for something holding secrets.
  }

  if (link?.isSymbolicLink() === true) {
    try {
      target = await realpath(path);
    } catch {
      // A dangling link. `realpath` threw, the catch left `target = path`, and
      // the rename replaced the link itself with a regular file - detaching
      // the dotfiles repository this code exists to protect, in the one case
      // where the user most obviously meant the link to stay.
      throw new Error(
        safe`${path} is a symlink whose target does not exist. TermStash will not replace the link; ` +
          "create the file it points at, or remove the link.",
      );
    }
  }

  try {
    const info = await stat(target);
    mode = info.mode & 0o777;
  } catch {
    // The target does not exist yet; keep 0600.
  }

  const staging = `${target}.termstash-${randomBytes(4).toString("hex")}`;
  try {
    await writeFile(staging, `${JSON.stringify(settings, null, 2)}\n`, { mode });
    await chmod(staging, mode);
    await rename(staging, target);
  } catch (error) {
    await rm(staging, { force: true });
    throw error;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Our own entry for an event: the command we would write, marker and all. */
function isOurs(entry: unknown, event: (typeof EVENTS)[number]): boolean {
  if (!isPlainObject(entry)) return false;
  const inner = entry["hooks"];
  if (!Array.isArray(inner)) return false;
  return inner.some((h) => isOurCommand(h, event));
}

/**
 * One definition of "ours", so matching and removal cannot drift apart.
 *
 * Matched on the command's tail rather than the word "termstash": an installed
 * package runs from `.../dist/cli.js`, which does not carry the package name.
 */
function isOurCommand(hook: unknown, event: (typeof EVENTS)[number]): boolean {
  if (!isPlainObject(hook)) return false;
  const command = hook["command"];
  return (
    typeof command === "string" &&
    command.trimEnd().endsWith(`# ${MARKER}`) &&
    command.includes(`hook ${event === "Stop" ? "stop" : "session-end"}`)
  );
}

/**
 * An entry with our hook taken out of it, or nothing if that empties it.
 *
 * Entries that are not ours come back untouched, including ones of shapes this
 * tool does not understand: they are the user's configuration, and an
 * uninstall is not a licence to tidy.
 */
function withoutOurs(entry: unknown, event: (typeof EVENTS)[number]): unknown {
  if (!isOurs(entry, event)) return entry;
  const record = entry as Record<string, unknown>;
  const inner = (record["hooks"] as unknown[]).filter((h) => !isOurCommand(h, event));
  if (inner.length === 0) return undefined;
  return { ...record, hooks: inner };
}

/**
 * The message arrives composed, and composing it is where `safe` belongs: the
 * caller knows which spans are its own layout and which are someone else's
 * text. Sanitising the finished message here would replace this tool's own
 * newlines with U+FFFD and fold a readable refusal into one unreadable line.
 */
function fail(message: string): number {
  err(`${message}\n`);
  return 1;
}

function onPath(): boolean {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", ["termstash"], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}
