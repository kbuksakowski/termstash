import { homedir } from "node:os";
import { join } from "node:path";

/**
 * TermStash's own state, deliberately separate from Claude's. PRD v0.2 section 26.
 *
 * TERMSTASH_HOME exists so the suite can run against a sandbox; nothing under
 * here is ever Claude-owned, but it does hold copies of transcripts and those
 * carry the same secrets (section 25).
 */
export function termstashRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["TERMSTASH_HOME"];
  // An explicitly set but empty value is a configuration mistake, not a request
  // for the default. Falling back silently pointed a test harness at the real
  // home directory, which is the one place this must never write by accident.
  if (override !== undefined && override.trim() === "") {
    throw new Error("TERMSTASH_HOME is set to an empty value. Unset it or give it a path.");
  }
  // Returned unmodified. Trimming every value, not just rejecting empty ones,
  // meant a directory whose name ends in a space resolved to a different path:
  // TermStash silently created a second config root and wrote a transcript
  // carrying secrets into it, reporting success.
  if (override !== undefined) return override;
  return join(homedir(), ".termstash");
}

export function archiveRoot(root: string): string {
  return join(root, "archive");
}

export function archiveDir(root: string, sessionId: string): string {
  return join(archiveRoot(root), sessionId);
}

export function quarantineRoot(root: string): string {
  return join(root, "quarantine");
}

export function metadataFile(root: string): string {
  return join(root, "metadata.json");
}

/** Directories 0700, files 0600: these hold transcript copies. */
export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;
