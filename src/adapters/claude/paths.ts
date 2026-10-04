import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Claude Code's config root. PRD v0.2 section 6.1.
 *
 * Every path in this adapter resolves through here, which is what lets the test
 * suite run against a sandbox instead of the developer's real data (section 48.5).
 */
export function claudeRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["CLAUDE_CONFIG_DIR"];
  // An explicitly set but empty value is a configuration mistake, not a request
  // for the default. Falling back silently pointed a test harness at the real
  // home directory, which is the one place this must never write by accident.
  if (override !== undefined && override.trim() === "") {
    throw new Error("CLAUDE_CONFIG_DIR is set to an empty value. Unset it or give it a path.");
  }
  // Returned unmodified. Trimming every value, not just rejecting empty ones,
  // meant a directory whose name ends in a space resolved to a different path:
  // TermStash silently created a second config root and wrote a transcript
  // carrying secrets into it, reporting success.
  if (override !== undefined) return override;
  return join(homedir(), ".claude");
}

export function projectsDir(root: string): string {
  return join(root, "projects");
}

/** Live-session registry, one file per running process. Section 16. */
export function liveSessionsDir(root: string): string {
  return join(root, "sessions");
}

/** Prompt history. Outlives transcripts. Section 6.7. */
export function historyFile(root: string): string {
  return join(root, "history.jsonl");
}

export function userSettingsFile(root: string): string {
  return join(root, "settings.json");
}

/** Per-session file snapshots used by Claude's checkpoint restore. */
export function fileHistoryDir(root: string): string {
  return join(root, "file-history");
}

/** Per-session environment metadata. */
export function sessionEnvDir(root: string): string {
  return join(root, "session-env");
}
