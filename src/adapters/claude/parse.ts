import { open } from "node:fs/promises";
import { NotARegularFile, openRegularFile } from "../../core/fs/regular.js";
import type { SessionOrigin, TitleSource } from "../../core/session/types.js";
import { KNOWN_RECORD_TYPES, extractPromptText, isHumanPrompt, parseLine, str } from "./records.js";
import type { TranscriptRecord } from "./records.js";

/**
 * Caps from PRD v0.2 section 28. The head is streamed rather than sampled
 * because a 256 KB window is NOT enough: some transcripts open with a long run
 * of file-history-snapshot records that fill it entirely (spike section 2.5).
 */
const HEAD_LINE_CAP = 2000;
const HEAD_BYTE_CAP = 8 * 1024 * 1024;
const TAIL_BYTES = 256 * 1024;
const CHUNK_BYTES = 64 * 1024;
const NEWLINE = 0x0a;

export type ParsedTranscript = {
  cwd?: string;
  cwdHistory: string[];
  gitBranch?: string;
  versions: string[];
  origin: SessionOrigin;
  createdAt?: Date;
  lastMessageAt?: Date;
  title?: string;
  titleSource?: TitleSource;
  internalSessionIds: string[];
  /** Record types we have never seen. An early signal that Claude's format moved. */
  unknownRecordTypes: string[];
  warnings: string[];
};

export async function parseTranscript(
  path: string,
  sizeBytes: number,
): Promise<ParsedTranscript> {
  const head = await readHead(path, sizeBytes);
  const tail =
    sizeBytes > head.bytesRead
      ? await readTail(path, sizeBytes)
      : { records: [], unparsable: 0 };

  return assemble(head, tail, sizeBytes);
}

type Chunk = { records: TranscriptRecord[]; unparsable: number };
type HeadChunk = Chunk & { bytesRead: number; truncated: boolean };

/** Stream from byte 0 until the metadata we need appears, or a cap is hit. */
async function readHead(path: string, sizeBytes: number): Promise<HeadChunk> {
  // Both readers here opened by name. A FIFO at a transcript path parked them
  // inside open(), which hung `list` for every session in the directory.
  const handle = await openRegularFile(path);
  if (handle === undefined) throw new NotARegularFile(path);
  const records: TranscriptRecord[] = [];
  let unparsable = 0;
  let bytesRead = 0;
  let lines = 0;
  let truncated = false;

  let sawCwd = false;
  let sawTimestamp = false;
  let sawPrompt = false;

  try {
    let pending = Buffer.alloc(0);
    const buffer = Buffer.alloc(CHUNK_BYTES);

    while (bytesRead < sizeBytes) {
      const { bytesRead: got } = await handle.read(buffer, 0, CHUNK_BYTES, bytesRead);
      if (got === 0) break;
      bytesRead += got;
      pending = Buffer.concat([pending, buffer.subarray(0, got)]);

      let start = 0;
      let index: number;
      while ((index = pending.indexOf(NEWLINE, start)) !== -1) {
        const line = pending.subarray(start, index).toString("utf8");
        start = index + 1;
        lines += 1;
        const record = parseLine(line);
        if (record === null) {
          if (line.trim() !== "") unparsable += 1;
        } else {
          records.push(record);
          if (str(record.cwd)) sawCwd = true;
          if (str(record.timestamp)) sawTimestamp = true;
          if (isHumanPrompt(record)) sawPrompt = true;
        }
        if (lines >= HEAD_LINE_CAP) break;
      }
      pending = pending.subarray(start);

      if (lines >= HEAD_LINE_CAP || bytesRead >= HEAD_BYTE_CAP) {
        // Hitting a cap means the scan stopped early, whether or not the read
        // happened to reach the end of the file. bytesRead is chunk-aligned, so
        // a cap reached inside the last chunk used to report a complete scan -
        // and doctor then called "no cwd" and "no conversation" confirmed
        // findings about a transcript that had both, a little past the cap.
        truncated = true;
        break;
      }
      if (sawCwd && sawTimestamp && sawPrompt) {
        truncated = bytesRead < sizeBytes;
        break;
      }
    }

    // A final line with no trailing newline - but only when the whole file was
    // read. Stopping early leaves a partial line in the buffer, and counting
    // that as malformed would report almost every transcript as corrupt.
    if (pending.length > 0 && bytesRead >= sizeBytes && lines < HEAD_LINE_CAP) {
      const line = pending.toString("utf8");
      const record = parseLine(line);
      if (record === null) {
        if (line.trim() !== "") unparsable += 1;
      } else {
        records.push(record);
      }
    }
  } finally {
    await handle.close();
  }

  return { records, unparsable, bytesRead, truncated };
}

/** Read the tail for the newest title records. Section 28. */
async function readTail(path: string, sizeBytes: number): Promise<Chunk> {
  const length = Math.min(TAIL_BYTES, sizeBytes);
  const position = sizeBytes - length;
  const handle = await openRegularFile(path);
  if (handle === undefined) throw new NotARegularFile(path);
  const records: TranscriptRecord[] = [];
  let unparsable = 0;

  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    const slice = buffer.subarray(0, bytesRead);

    // Drop the leading partial line unless we happen to start at a boundary.
    const firstNewline = position === 0 ? -1 : slice.indexOf(NEWLINE);
    const usable = firstNewline === -1 ? slice : slice.subarray(firstNewline + 1);

    for (const line of usable.toString("utf8").split("\n")) {
      if (line.trim() === "") continue;
      const record = parseLine(line);
      if (record === null) unparsable += 1;
      else records.push(record);
    }
  } finally {
    await handle.close();
  }

  return { records, unparsable };
}

function assemble(head: HeadChunk, tail: Chunk, sizeBytes: number): ParsedTranscript {
  const all = [...head.records, ...tail.records];
  const warnings: string[] = [];

  const cwd = firstOf(head.records, (r) => str(r.cwd));
  const gitBranch = firstOf(head.records, (r) => str(r.gitBranch));
  const createdAt = firstOf(head.records, (r) => toDate(r.timestamp));

  const versions = distinct(all, (r) => str(r.version));
  const cwdHistory = distinct(all, (r) => str(r.cwd));
  const internalSessionIds = distinct(all, (r) => str(r.sessionId));
  const unknownRecordTypes = distinct(all, (r) => {
    const type = str(r.type);
    return type !== undefined && !KNOWN_RECORD_TYPES.has(type) ? type : undefined;
  });

  const lastMessageAt =
    lastOf(tail.records, (r) => toDate(r.timestamp)) ??
    lastOf(head.records, (r) => toDate(r.timestamp));

  // custom-title beats ai-title beats the first human prompt. Section 10.
  // Title records are appended repeatedly, so the LAST one is current.
  const customTitle = lastOf(all, (r) =>
    r.type === "custom-title" ? str(r.customTitle) : undefined,
  );
  const aiTitle = lastOf(all, (r) => (r.type === "ai-title" ? str(r.aiTitle) : undefined));
  const firstPrompt = firstOf(head.records, (r) =>
    isHumanPrompt(r) ? promptText(r) : undefined,
  );

  let title: string | undefined;
  let titleSource: TitleSource | undefined;
  if (customTitle) {
    title = customTitle;
    titleSource = "custom";
  } else if (aiTitle) {
    title = aiTitle;
    titleSource = "ai";
  } else if (firstPrompt) {
    title = firstPrompt;
    titleSource = "first-prompt";
  }

  if (!cwd) {
    warnings.push(
      head.truncated
        ? `no cwd found within the first ${HEAD_LINE_CAP} lines`
        : "transcript contains no cwd",
    );
  }
  const unparsable = head.unparsable + tail.unparsable;
  if (unparsable > 0) {
    // The head stops early once metadata is found, so this is a floor.
    warnings.push(
      head.truncated
        ? `at least ${unparsable} unparsable line(s)`
        : `${unparsable} unparsable line(s)`,
    );
  }
  if (all.length === 0 && sizeBytes > 0) warnings.push("no readable records");
  if (internalSessionIds.length > 1) {
    warnings.push(`transcript mixes ${internalSessionIds.length} session ids`);
  }

  return {
    ...(cwd !== undefined ? { cwd } : {}),
    cwdHistory,
    ...(gitBranch !== undefined ? { gitBranch } : {}),
    versions,
    origin: readOrigin(head.records),
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(lastMessageAt !== undefined ? { lastMessageAt } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(titleSource !== undefined ? { titleSource } : {}),
    internalSessionIds,
    unknownRecordTypes,
    warnings,
  };
}

function promptText(record: TranscriptRecord): string | undefined {
  const message = record.message;
  if (typeof message !== "object" || message === null) return undefined;
  return extractPromptText((message as { content?: unknown }).content);
}

function readOrigin(records: TranscriptRecord[]): SessionOrigin {
  const entrypoint = firstOf(records, (r) => str(r.entrypoint));
  if (entrypoint === "cli") return "interactive";
  if (entrypoint === "sdk-cli") return "sdk-cli";
  return "unknown";
}

function toDate(value: unknown): Date | undefined {
  const text = str(value);
  if (!text) return undefined;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function firstOf<T>(records: TranscriptRecord[], pick: (r: TranscriptRecord) => T | undefined) {
  for (const record of records) {
    const value = pick(record);
    if (value !== undefined) return value;
  }
  return undefined;
}

function lastOf<T>(records: TranscriptRecord[], pick: (r: TranscriptRecord) => T | undefined) {
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const record = records[i];
    if (record === undefined) continue;
    const value = pick(record);
    if (value !== undefined) return value;
  }
  return undefined;
}

function distinct(
  records: TranscriptRecord[],
  pick: (r: TranscriptRecord) => string | undefined,
): string[] {
  const seen = new Set<string>();
  for (const record of records) {
    const value = pick(record);
    if (value !== undefined) seen.add(value);
  }
  return [...seen];
}
