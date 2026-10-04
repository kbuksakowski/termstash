import { mkdtempSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeEach } from "vitest";

/**
 * PRD v0.2 section 48.5. This is an assertion, not a convention.
 *
 * The whole test suite drives an adapter that reads Claude Code's storage. A
 * test that resolved the real config root would read - and in later phases
 * write - the developer's actual sessions. Point CLAUDE_CONFIG_DIR at a
 * throwaway directory before anything runs, and refuse to proceed if it ever
 * resolves to the real one.
 */
const REAL_CLAUDE = resolve(join(homedir(), ".claude"));
const REAL_TERMSTASH = resolve(join(homedir(), ".termstash"));

function guard(root: string, real: string, label: string, variable: string): void {
  const resolved = resolve(root);
  if (resolved === real || resolved.startsWith(`${real}/`)) {
    throw new Error(
      `Refusing to run tests against the real ${label} (${resolved}). ` +
        `Tests must use a temporary ${variable}.`,
    );
  }
}

beforeEach(() => {
  const claude = realpathSync(mkdtempSync(join(tmpdir(), "termstash-claude-")));
  guard(claude, REAL_CLAUDE, "Claude config root", "CLAUDE_CONFIG_DIR");
  process.env["CLAUDE_CONFIG_DIR"] = claude;

  // TermStash's own root holds archived transcripts and quarantined ones, so it
  // carries the same secrets and gets the same treatment.
  const own = realpathSync(mkdtempSync(join(tmpdir(), "termstash-home-")));
  guard(own, REAL_TERMSTASH, "TermStash home", "TERMSTASH_HOME");
  process.env["TERMSTASH_HOME"] = own;
});
