import type { Session } from "../session/types.js";

/**
 * Where a query matched. Ordered by how much the match tells the user:
 * a title hit identifies a session, a transcript hit only proves the words
 * appeared somewhere inside it. PRD v0.2 section 29.
 */
export type MatchField = "title" | "project" | "prompt" | "transcript";

const FIELD_RANK: Record<MatchField, number> = {
  title: 0,
  project: 1,
  prompt: 2,
  transcript: 3,
};

export type SessionMatch = {
  session: Session;
  fields: MatchField[];
  hits: number;
  /** Already truncated for display. Section 25. */
  snippet?: string;
  snippetField?: MatchField;
};

export function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}

export function contains(haystack: string | undefined, needle: string): boolean {
  return haystack !== undefined && haystack.toLowerCase().includes(needle);
}

export const SNIPPET_CONTEXT = 40;
export const SNIPPET_MAX = 120;

/**
 * A window around the first hit, collapsed to one line.
 *
 * Transcripts hold credentials and command output, so a snippet is a fixed
 * small window and never a whole record: section 25 forbids dumping raw
 * transcript content by default.
 */
export function snippet(text: string, needle: string): string | undefined {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat === "") return undefined;
  const at = flat.toLowerCase().indexOf(needle);
  if (at === -1) return undefined;

  const start = Math.max(0, at - SNIPPET_CONTEXT);
  const end = Math.min(flat.length, at + needle.length + SNIPPET_CONTEXT);
  const body = flat.slice(start, end).slice(0, SNIPPET_MAX);

  return `${start > 0 ? "…" : ""}${body}${end < flat.length ? "…" : ""}`;
}

/** Strongest field first, then most recent. Section 13 asks for no more. */
export function rankMatches(matches: readonly SessionMatch[]): SessionMatch[] {
  return [...matches].sort((a, b) => {
    const byField = bestRank(a.fields) - bestRank(b.fields);
    if (byField !== 0) return byField;
    return b.session.updatedAt.getTime() - a.session.updatedAt.getTime();
  });
}

function bestRank(fields: readonly MatchField[]): number {
  return fields.reduce((best, field) => Math.min(best, FIELD_RANK[field]), Number.MAX_SAFE_INTEGER);
}
