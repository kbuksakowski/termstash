import { discoverSessions } from "../adapters/claude/discover.js";
import type { Discovery } from "../adapters/claude/discover.js";
import { termstashRoot } from "../core/paths.js";
import { assignShortIds } from "../core/short-id/index.js";
import { allSessions } from "./sessions.js";
import { readOverlay } from "./list.js";
import type { ParsedArgs } from "./args.js";
import { flagBool, flagNumber } from "./args.js";
import { err, jsonOut, out, relativeTime, renderTable, safe, safeText, terminalWidth } from "./format.js";

const DEFAULT_COUNT = 5;

export type LastDeps = {
  discover?: () => Promise<Discovery>;
  now?: Date;
};

/**
 * The sessions you were most recently in that are no longer open.
 *
 * The question this answers is the one people actually ask: the laptop lid
 * closed, the terminal came back without the session, and the work is
 * somewhere in one of a dozen projects. `claude --resume` lists the current
 * directory; `claude --continue` takes its last session. A session from
 * another project, or from a worktree, is in neither.
 *
 * It was being answered already, by Claude, from `list`: read 300 sessions and
 * infer "changed a moment ago and not live". That worked, and it was
 * reasoning where there should have been an answer.
 *
 * Deliberately plain: live sessions are left out (that is the one you are in,
 * or the one you did not lose), and so are headless `claude -p` and SDK runs,
 * which nobody was sitting in. Nothing is guessed beyond that - a short
 * `/commit` session is still a session, and the list is newest first, so the
 * one you want is at the top.
 */
export async function lastCommand(args: ParsedArgs, deps: LastDeps = {}): Promise<number> {
  const now = deps.now ?? new Date();
  const count = flagNumber(args, "limit") ?? DEFAULT_COUNT;
  const discover = deps.discover ?? (() => discoverSessions({ now }));

  const { sessions, unreadable } = await allSessions({ root: termstashRoot(), discover });
  const overlay = await readOverlay(sessions);
  // Over every session, as `list` does, so the id printed here is the one
  // `resume` accepts.
  const shortIds = assignShortIds(sessions.map((s) => s.id));

  const closed = sessions
    .filter((s) => !s.isLive && s.archivedOnly !== true && s.origin !== "sdk-cli")
    .slice(0, count);
  const label = (id: string) => shortIds.get(id) ?? id;

  if (flagBool(args, "json")) {
    jsonOut({
      sessions: closed.map((s) => ({
        id: s.id,
        shortId: label(s.id),
        projectName: s.projectName,
        projectPath: s.projectPath,
        title: overlay.titles.get(s.id) ?? s.title,
        updatedAt: s.updatedAt,
        resume: `termstash resume ${label(s.id)}`,
      })),
      // The same envelope `list --json` carries: an agent reads stdout, and
      // "no recent sessions" and "could not look" must not read the same.
      searched: {
        scanPartial: unreadable.length > 0,
        unreadableLocations: unreadable.map((entry) => entry.path),
      },
    });
    return 0;
  }

  if (unreadable.length > 0) {
    err(safe`${unreadable.length} location(s) could not be read, so sessions there are not listed.\n`);
  }
  if (closed.length === 0) {
    out("No recently active sessions that are closed. Every session found is still open.\n");
    return 0;
  }

  const lines = renderTable(
    [
      { header: "ID", min: 6 },
      { header: "PROJECT", min: 8 },
      { header: "LAST ACTIVE", min: 11 },
      { header: "SESSION", flex: 1, min: 20 },
    ],
    closed.map((s) => [
      label(s.id),
      s.projectName ?? "—",
      relativeTime(s.updatedAt, now),
      overlay.titles.get(s.id) ?? s.title ?? "—",
    ]),
    terminalWidth() - 2,
  );

  out("\nRecently active sessions that are no longer open\n\n");
  for (const line of lines) out(safe`  ${line}\n`);
  const first = closed[0];
  if (first !== undefined) {
    out(safe`\nResume the most recent:\n  termstash resume ${safeText(label(first.id))}\n`);
  }
  return 0;
}
