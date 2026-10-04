import { spawn } from "node:child_process";

export type LaunchRequest = {
  sessionId: string;
  cwd: string;
};

export type LaunchResult = { code: number };

export type Launcher = (request: LaunchRequest) => Promise<LaunchResult>;

/** Overridable so tests can assert what would be launched without launching it. */
export const CLAUDE_BINARY = process.env["TERMSTASH_CLAUDE_BIN"] ?? "claude";

/**
 * Hand the terminal to Claude. PRD v0.2 section 15.
 *
 * TermStash's job ends here: it found the session and resolved the working
 * directory. Claude owns the conversation, the TTY and the exit code.
 */
export const launchClaude: Launcher = async ({ sessionId, cwd }) => {
  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_BINARY, ["--resume", sessionId], {
      cwd,
      stdio: "inherit",
    });

    // Ctrl-C reaches the whole foreground group. Let Claude decide what it
    // means; exiting the parent first would orphan an interactive session.
    const passThrough = () => {};
    process.on("SIGINT", passThrough);
    process.on("SIGTERM", passThrough);

    const cleanup = () => {
      process.off("SIGINT", passThrough);
      process.off("SIGTERM", passThrough);
    };

    child.on("error", (error: NodeJS.ErrnoException) => {
      cleanup();
      if (error.code === "ENOENT") {
        reject(
          new Error(
            `Could not find the '${CLAUDE_BINARY}' command on PATH. ` +
              "TermStash delegates resuming to Claude Code and cannot do it alone.",
          ),
        );
        return;
      }
      reject(error);
    });

    child.on("close", (code, signal) => {
      cleanup();
      resolve({ code: signal !== null ? 1 : (code ?? 0) });
    });
  });
};
