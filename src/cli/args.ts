/** Minimal argument parsing. Zero dependencies by design. */

import { quoted, safe } from "./format.js";

/**
 * Flags that never take a value.
 *
 * Without this the parser treats the token after any flag as its value, so
 * `search --json alpha` loses the query and `rename <id> --clear` deletes the
 * title the user was trying to set. A parser that guesses is a parser that
 * destroys data on a Tuesday.
 */
const BOOLEAN_FLAGS = new Set([
  "json", "details", "at-risk", "live", "pinned", "replace", "clear",
  "uninstall", "help", "version",
]);

export type ParsedArgs = {
  command?: string;
  positionals: string[];
  flags: Map<string, string | true>;
};

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined) continue;

    if (token === "--") {
      positionals.push(...argv.slice(i + 1).filter((v): v is string => v !== undefined));
      break;
    }

    if (token.startsWith("--")) {
      const body = token.slice(2);
      const eq = body.indexOf("=");
      if (eq !== -1) {
        const name = body.slice(0, eq);
        const value = body.slice(eq + 1);
        // `--replace=false` set the flag to the string "false", and `flagBool`
        // asks only whether the flag is present - so writing the word that
        // means no performed the replacement. On `restore` and `archive` that
        // is the destructive branch: the user typed a refusal and got the
        // overwrite, with the displaced copy saved by the quarantine rather
        // than by anything they asked for.
        if (BOOLEAN_FLAGS.has(name)) {
          const truth = booleanValue(value);
          if (truth === undefined) {
            throw new Error(
              safe`--${name} is a yes/no flag and does not take ${quoted(value)}. ` +
                safe`Write --${name} to turn it on, or leave it out.`,
            );
          }
          // Absent is how "off" is spelled here: `flagBool` reads presence, and
          // storing `false` would put the old bug back one layer down.
          if (truth) flags.set(name, true);
          continue;
        }
        flags.set(name, value);
        continue;
      }
      if (BOOLEAN_FLAGS.has(body)) {
        flags.set(body, true);
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        flags.set(body, next);
        i += 1;
      } else {
        flags.set(body, true);
      }
      continue;
    }

    if (token.startsWith("-") && token.length > 1) {
      flags.set(token.slice(1), true);
      continue;
    }

    positionals.push(token);
  }

  const [command, ...rest] = positionals;
  return {
    ...(command !== undefined ? { command } : {}),
    positionals: rest,
    flags,
  };
}

/** Only spellings with one reading. Anything else is refused rather than guessed. */
function booleanValue(value: string): boolean | undefined {
  const normalised = value.trim().toLowerCase();
  if (normalised === "true" || normalised === "yes" || normalised === "1") return true;
  if (normalised === "false" || normalised === "no" || normalised === "0") return false;
  return undefined;
}

export function flagString(args: ParsedArgs, name: string): string | undefined {
  if (!args.flags.has(name)) return undefined;
  const value = args.flags.get(name);
  // `--cwd ""` was fixed and the sibling branch was left: a value flag written
  // with no value at all, or with one the parser read as the next flag, became
  // `true` here and `undefined` to the caller - indistinguishable from never
  // having been typed. `--cwd` alone therefore started Claude in the
  // transcript's own project directory while the user believed they had
  // chosen one. Present but valueless is a mistake, and gets said out loud.
  if (typeof value !== "string") {
    throw new Error(safe`--${name} needs a value. Write --${name}=<value> if it begins with a dash.`);
  }
  // A flag given an empty value is an unset shell variable far more often than
  // it is a deliberate empty string, and the quiet readings are the dangerous
  // ones: `--cwd ""` used to start Claude in whatever directory you happened to
  // be in, with that project's CLAUDE.md and permissions.
  if (value.trim() === "") throw new Error(safe`--${name} was given an empty value.`);
  return value;
}

export function flagBool(args: ParsedArgs, name: string): boolean {
  return args.flags.has(name);
}

export function flagNumber(args: ParsedArgs, name: string): number | undefined {
  const value = flagString(args, name);
  if (value === undefined) return undefined;
  // parseInt stops at the first character it does not understand, so "1e9"
  // silently meant 1 and "abc" silently meant no limit at all. Say so instead.
  if (!/^[0-9]+$/.test(value.trim())) {
    throw new Error(safe`--${name} expects a whole number, got ${quoted(value)}.`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(safe`--${name} expects a number above zero, got ${quoted(value)}.`);
  }
  return parsed;
}
