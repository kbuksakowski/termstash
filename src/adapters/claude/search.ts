import type { MatchField } from "../../core/search/index.js";
import { snippet } from "../../core/search/index.js";
import { extractPromptText, isHumanPrompt, parseLine } from "./records.js";
import type { TranscriptRecord } from "./records.js";
import { readLines } from "./lines.js";

export type TranscriptHit = {
  /** Lines too long to read. Zero for every ordinary transcript. */
  skippedLines?: number;
  field: MatchField;
  hits: number;
  snippet?: string;
};

/**
 * Stream a transcript looking for a query.
 *
 * Two things make this affordable on a 400 MB corpus without an index or an
 * external binary (PRD v0.2 section 29): lines are tested as raw text first and
 * only JSON.parsed when they already contain the query, and a file stops being
 * read once enough evidence is collected.
 */
export async function searchTranscript(
  path: string,
  rawNeedle: string,
  options: { maxHits?: number } = {},
): Promise<TranscriptHit | undefined> {
  // Lines readLines refused to buffer. Counted here and reported by the
  // caller: a search that quietly looked at less than it claims is the failure
  // this file's own comment says it exists to prevent, and the counter was
  // built and then never read by anything.
  let skippedLines = 0;
  const maxHits = options.maxHits ?? 50;
  // Normalise here rather than trusting the caller. Matching is
  // case-insensitive throughout, and a caller that passed mixed case used to
  // silently match nothing.
  const needle = rawNeedle.toLowerCase();
  // Testing a precompiled case-insensitive regex avoids allocating a lowercased
  // copy of every line in the corpus, which is the dominant cost of a scan.
  const gate = new RegExp(escapeRegExp(needle), "i");
  let hits = 0;
  let best: { field: MatchField; snippet: string } | undefined;

  // Errors are not swallowed here. A transcript that vanished or cannot be read
  // is counted and reported by the caller, because a search that quietly looked
  // at fewer files than it claims is worse than one that fails.
  for await (const { line, skipped } of readLines(path)) {
    skippedLines = skipped;
    // Cheap gate. Most lines never reach the parser.
    if (!gate.test(line)) continue;

    const record = parseLine(line);
    if (record === null) continue;

    const found = matchInRecord(record, needle);
    if (found === undefined) continue;

    hits += 1;
    // A human prompt is worth more than assistant prose; keep the best one.
    if (best === undefined || (found.field === "prompt" && best.field !== "prompt")) {
      best = found;
    }
    if (hits >= maxHits) break;
  }

  if (hits === 0 && skippedLines === 0) return undefined;
  return {
    field: best?.field ?? "transcript",
    hits,
    ...(skippedLines > 0 ? { skippedLines } : {}),
    ...(best?.snippet !== undefined ? { snippet: best.snippet } : {}),
  };
}

/**
 * Only text a person wrote or read counts. Attachments, tool results and
 * file-history snapshots routinely contain the query by coincidence - matching
 * them would surface blobs instead of conversations (section 29).
 */
function matchInRecord(
  record: TranscriptRecord,
  needle: string,
): { field: MatchField; snippet: string } | undefined {
  if (isHumanPrompt(record)) {
    const text = extractPromptText(messageContent(record));
    const found = text === undefined ? undefined : snippet(text, needle);
    if (found !== undefined) return { field: "prompt", snippet: found };
    return undefined;
  }

  if (record.type === "assistant") {
    const text = assistantText(messageContent(record));
    const found = text === undefined ? undefined : snippet(text, needle);
    if (found !== undefined) return { field: "transcript", snippet: found };
  }

  return undefined;
}

function messageContent(record: TranscriptRecord): unknown {
  const message = record.message;
  if (typeof message !== "object" || message === null) return undefined;
  return (message as { content?: unknown }).content;
}

/** Assistant text blocks only: not thinking, not tool_use inputs. */
function assistantText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;

  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as { type?: unknown; text?: unknown };
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
