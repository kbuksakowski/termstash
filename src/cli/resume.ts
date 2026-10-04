import { stat } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { discoverSessions } from "../adapters/claude/discover.js";
import type { Discovery } from "../adapters/claude/discover.js";
import { hasTerminal, launchClaude, resumeCommandLine } from "../adapters/claude/resume.js";
import type { Launcher } from "../adapters/claude/resume.js";
import type { Session } from "../core/session/types.js";
import { assignShortIds, resolveShortId } from "../core/short-id/index.js";
import type { ParsedArgs } from "./args.js";
import { flagString } from "./args.js";
import { allSessions, duplicateSessionMessage, oneSession } from "./sessions.js";
import { termstashRoot } from "../core/paths.js";
import { err, quoted, relativeTime, safe, truncate } from "./format.js";

export type ResumeDeps = {
  discover?: () => Promise<Discovery>;
  launcher?: Launcher;
  now?: Date;
};

export async function resumeCommand(args: ParsedArgs, deps: ResumeDeps = {}): Promise<number> {
  const now = deps.now ?? new Date();
  const handle = args.positionals[0];

  if (handle === undefined) {
    return fail(
      "termstash resume needs a session id.\n" +
        "  termstash list          to see your sessions\n" +
        "  termstash resume 7f31a2 to resume one",
    );
  }

  const discover = deps.discover ?? (() => discoverSessions({ now }));
  // Archives are in scope here only so the refusal can be accurate. Claude
  // resumes from its own storage, so an archived session genuinely cannot be
  // resumed until it is restored - but "No session matches" was the wrong
  // reason, and sent the user looking for something that was never lost.
  const { sessions } = await allSessions({ root: termstashRoot(), discover });

  const resolution = resolveShortId(
    sessions.map((s) => s.id),
    handle,
  );

  if (resolution.status === "none") {
    return fail(
      safe`No session matches ${quoted(handle)}.\n` +
        "Run 'termstash list' to see what is available.\n" +
        "Note that a session whose transcript Claude has already deleted cannot be resumed.",
    );
  }

  if (resolution.status === "ambiguous") {
    // Never guess. Resuming the wrong session looks exactly like losing the right one.
    const shortIds = assignShortIds(sessions.map((s) => s.id));
    const lines = resolution.candidates.map((id) => {
      const session = sessions.find((s) => s.id === id);
      const label = shortIds.get(id) ?? id;
      const project = session?.projectName ?? "—";
      const when = session ? relativeTime(session.updatedAt, now) : "";
      // Titles are user text and run long; an unwrapped list is unreadable
      // exactly when the user most needs to pick one.
      const title = truncate(session?.title ?? "", 56);
      return safe`  ${label}  ${project}  ${when}  ${title}`.trimEnd();
    });
    return fail(
      `${quoted(handle)} matches ${resolution.candidates.length} sessions:\n${lines.join("\n")}\n\n` +
        "Use a longer id.",
    );
  }

  const picked = oneSession(sessions, resolution.id);
  if (!("session" in picked)) {
    if (picked.duplicates.length === 0) return fail(safe`No session matches ${quoted(handle)}.`);
    // Claude resumes from a path, and two transcripts carry this id. Starting
    // the wrong one looks exactly like losing the right one.
    return fail(
      duplicateSessionMessage(
        assignShortIds(sessions.map((s) => s.id)).get(resolution.id) ?? resolution.id,
        picked.duplicates,
      ),
    );
  }
  const session = picked.session;

  if (session.archivedOnly === true) {
    const label = shortLabel(sessions, session);
    return fail(
      safe`Claude no longer has the transcript for ${label}; TermStash has an archive of it.\n` +
        "Claude resumes from its own storage, so the archive has to go back first:\n\n" +
        safe`  termstash restore ${label}\n` +
        safe`  termstash resume ${label}`,
    );
  }

  if (session.isLive) {
    // Resuming twice interleaves both conversations into one transcript.
    return fail(
      safe`Session ${shortLabel(sessions, session)} is currently active in another Claude process.\n` +
        "Refusing to resume the same session concurrently.",
    );
  }

  const cwd = await resolveWorkingDirectory(args, session, sessions);
  if (typeof cwd !== "string") return fail(cwd.error);

  // Checked for the real launcher only: an injected one is a test standing in
  // for Claude, and the question is whether Claude would get a terminal.
  // Thrown, this message reached main() and lost its newlines to the
  // sanitiser there; said here, it keeps them.
  if (deps.launcher === undefined && !hasTerminal()) {
    return fail(
      "resume hands the terminal to Claude, and this process has none - it is\n" +
        "running inside an agent, a script or a pipe. Nothing was launched.\n\n" +
        "To resume it, run this in a terminal:\n" +
        safe`  ${resumeCommandLine(session.id, cwd)}`,
    );
  }

  const launcher = deps.launcher ?? launchClaude;
  const { code } = await launcher({ sessionId: session.id, cwd });
  return code;
}

type CwdError = { error: string };

/**
 * PRD v0.2 section 15. There is no silent fallback to the current directory:
 * Claude loads CLAUDE.md, permissions, MCP servers and agents from wherever it
 * starts, so choosing on the user's behalf would run the session against the
 * wrong project's configuration.
 */
async function resolveWorkingDirectory(
  args: ParsedArgs,
  session: Session,
  sessions: readonly Session[],
): Promise<string | CwdError> {
  const override = flagString(args, "cwd");

  if (override !== undefined) {
    const absolute = resolvePath(override);
    if (!(await isDirectory(absolute))) {
      return { error: safe`--cwd must point to an existing directory: ${absolute}` };
    }
    return absolute;
  }

  if (session.projectPath !== undefined && session.projectPathExists === true) {
    return session.projectPath;
  }

  const label = shortLabel(sessions, session);
  const original = session.projectPath ?? "unknown";
  return {
    error:
      safe`TermStash cannot find the original project directory for ${label}:\n\n` +
      safe`  ${original}\n\n` +
      "Choose an existing working directory:\n\n" +
      safe`  termstash resume ${label} --cwd /path/to/project`,
  };
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function shortLabel(sessions: readonly Session[], session: Session): string {
  return assignShortIds(sessions.map((s) => s.id)).get(session.id) ?? session.id;
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
