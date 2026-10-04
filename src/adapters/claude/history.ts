import { lstat } from "node:fs/promises";
import { describeError } from "../../core/text/safe.js";
import { historyFile } from "./paths.js";
import { readLines } from "./lines.js";

/**
 * Claude's prompt history. PRD v0.2 section 6.7.
 *
 * This file is not part of the retention sweep, so it outlives the transcripts
 * it refers to. That makes it the only local proof that a session existed after
 * Claude has deleted the conversation itself.
 */
export type HistorySession = {
  id: string;
  projectPath?: string;
  firstSeen: Date;
  lastSeen: Date;
  promptCount: number;
  /** A capped sample for display. Search streams the file instead. */
  prompts: string[];
};

export type HistoryScan = {
  sessions: HistorySession[];
  /**
   * Records with no sessionId. Older Claude builds did not write one, so these
   * cannot be attributed to a session. Counted, never guessed at: grouping them
   * by project and timestamp would invent sessions that may never have existed
   * (section 14).
   */
  unattributed: number;
  /** Set when history.jsonl exists and could not be read. */
  unreadable?: string;
};

const PROMPT_SAMPLE_CAP = 5;

type RawEntry = {
  display?: unknown;
  project?: unknown;
  sessionId?: unknown;
  timestamp?: unknown;
};

export async function readHistory(root: string): Promise<HistoryScan> {
  const byId = new Map<string, HistorySession>();
  let unattributed = 0;

  const unreadable = await forEachEntry(root, (entry) => {
    const id = typeof entry.sessionId === "string" ? entry.sessionId : undefined;
    if (id === undefined || id === "") {
      unattributed += 1;
      return;
    }
    const at = toDate(entry.timestamp);
    if (at === undefined) return;

    const display = typeof entry.display === "string" ? entry.display.trim() : "";
    const project = typeof entry.project === "string" ? entry.project : undefined;
    const current = byId.get(id);

    if (current === undefined) {
      byId.set(id, {
        id,
        ...(project !== undefined ? { projectPath: project } : {}),
        firstSeen: at,
        lastSeen: at,
        promptCount: 1,
        prompts: display === "" ? [] : [display],
      });
      return;
    }

    if (at < current.firstSeen) current.firstSeen = at;
    if (at > current.lastSeen) current.lastSeen = at;
    current.promptCount += 1;
    if (display !== "" && current.prompts.length < PROMPT_SAMPLE_CAP) current.prompts.push(display);
  });

  return {
    sessions: [...byId.values()],
    unattributed,
    ...(unreadable !== undefined ? { unreadable } : {}),
  };
}

export type HistoryMatch = {
  id: string;
  projectPath?: string;
  lastSeen: Date;
  hits: number;
  snippet: string;
};

/**
 * Search the prompt history directly, so a query can find work whose transcript
 * is already gone. Streams rather than holding every prompt in memory.
 */
export async function searchHistory(
  root: string,
  rawNeedle: string,
  makeSnippet: (text: string, needle: string) => string | undefined,
): Promise<Map<string, HistoryMatch>> {
  // Same reason as searchTranscript: matching is case-insensitive, so do not
  // depend on the caller having lowercased first.
  const needle = rawNeedle.toLowerCase();
  const matches = new Map<string, HistoryMatch>();

  const unreadable = await forEachEntry(root, (entry) => {
    const id = typeof entry.sessionId === "string" ? entry.sessionId : undefined;
    const display = typeof entry.display === "string" ? entry.display : undefined;
    if (id === undefined || display === undefined) return;
    if (!display.toLowerCase().includes(needle)) return;

    const at = toDate(entry.timestamp) ?? new Date(0);
    const project = typeof entry.project === "string" ? entry.project : undefined;
    const existing = matches.get(id);

    if (existing === undefined) {
      matches.set(id, {
        id,
        ...(project !== undefined ? { projectPath: project } : {}),
        lastSeen: at,
        hits: 1,
        snippet: makeSnippet(display, needle) ?? display.slice(0, 120),
      });
      return;
    }
    existing.hits += 1;
    if (at > existing.lastSeen) existing.lastSeen = at;
  });

  return matches;
}

/**
 * Set when the history file exists and could not be read.
 *
 * "Could not look" was swallowed here and `search` then printed "Searched …
 * and Claude's prompt history" with "No matches" above it - about the one
 * source that outlives Claude's sweep, which is to say about the only evidence
 * a lost session leaves. Every other source in that command distinguishes the
 * two; this one was treated as infallible.
 */
async function forEachEntry(
  root: string,
  visit: (entry: RawEntry) => void,
): Promise<string | undefined> {
  const path = historyFile(root);
  try {
    for await (const { line } of readLines(path)) {
      if (line.trim() === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof parsed !== "object" || parsed === null) continue;
      visit(parsed as RawEntry);
    }
    return undefined;
  } catch (error) {
    const present = await lstat(path)
      .then(() => true)
      .catch(() => false);
    return present ? describeError(error) : undefined;
  }
}

function toDate(value: unknown): Date | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Finite is not the same as representable: new Date(1e300) is an Invalid
    // Date, and one of those in history.jsonl took the whole doctor report
    // down with "Invalid time value".
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  if (typeof value === "string") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  return undefined;
}
