import type { HistorySession } from "../../adapters/claude/history.js";

/**
 * A session Claude's prompt history proves existed, whose transcript is gone.
 * PRD v0.2 section 14.
 */
export type LostSession = {
  id: string;
  projectPath?: string;
  firstSeen: Date;
  lastSeen: Date;
  promptCount: number;
  prompts: string[];
  resumable: false;
};

/**
 * What can still be done with a session the prompt history remembers.
 *
 * "archived" outranks "lost": an archived session is not lost, it is one
 * `termstash restore` away, and saying otherwise would understate what the
 * user actually has.
 */
export type HistoricalState = "resumable" | "archived" | "lost";

export function classifyHistorical(
  id: string,
  liveIds: ReadonlySet<string>,
  archivedIds: ReadonlySet<string>,
): HistoricalState {
  if (liveIds.has(id)) return "resumable";
  if (archivedIds.has(id)) return "archived";
  return "lost";
}

export function toLostSessions(
  history: readonly HistorySession[],
  liveIds: ReadonlySet<string>,
  archivedIds: ReadonlySet<string>,
): LostSession[] {
  return history
    .filter((session) => classifyHistorical(session.id, liveIds, archivedIds) === "lost")
    .map((session) => ({ ...session, resumable: false as const }))
    .sort((a, b) => b.lastSeen.getTime() - a.lastSeen.getTime());
}
