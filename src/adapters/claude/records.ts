/**
 * Shapes we read out of a transcript. PRD v0.2 section 5.2: tolerate unknown
 * record types, tolerate missing fields, never crash on one bad line.
 *
 * Everything here is optional on purpose. A record is whatever Claude wrote.
 */

export type TranscriptRecord = {
  type?: unknown;
  sessionId?: unknown;
  timestamp?: unknown;
  cwd?: unknown;
  gitBranch?: unknown;
  version?: unknown;
  entrypoint?: unknown;
  isMeta?: unknown;
  isSidechain?: unknown;
  toolUseResult?: unknown;
  message?: { role?: unknown; content?: unknown } | unknown;
  customTitle?: unknown;
  aiTitle?: unknown;
};

/**
 * Record types observed on Claude Code 2.1.263 during the technical spike and on
 * 2.1.269 and 2.1.289, plus the legacy `summary` older versions wrote.
 *
 * Nothing branches on this list. It exists so `doctor` can notice the format
 * drifting - Claude's docs state the transcript format is internal and can
 * change on any release, which is the highest risk this project carries.
 */
export const KNOWN_RECORD_TYPES: ReadonlySet<string> = new Set([
  "agent-name", "ai-title", "artifact-autoreact-ledger", "artifact-comment-monitor",
  "assistant", "atis-latch", "attachment", "bridge-session", "cost-state", "custom-title",
  "file-history-delta", "file-history-snapshot", "frame-link", "history-suppression",
  "last-prompt", "mode", "permission-mode", "pr-link", "queue-operation", "summary",
  "system", "user",
]);

export function parseLine(line: string): TranscriptRecord | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  try {
    const value: unknown = JSON.parse(trimmed);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    return value as TranscriptRecord;
  } catch {
    return null;
  }
}

export function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * A real human turn: not injected system noise, not a tool result, not a
 * subagent. PRD section 10.
 */
export function isHumanPrompt(record: TranscriptRecord): boolean {
  if (record.type !== "user") return false;
  if (record.isMeta === true) return false;
  if (record.isSidechain === true) return false;
  if (record.toolUseResult !== undefined && record.toolUseResult !== null) return false;
  return true;
}

/**
 * Longest prompt worth cleaning up. A title comes from the first line or two,
 * and everything past this is cost without benefit.
 */
const PROMPT_SCAN_CAP = 64 * 1024;

/**
 * Remove `<tag>...</tag>` spans, scanning forward once.
 *
 * This replaced two lazy regexes. `/<tag>[\s\S]*?<\/tag>/g` is quadratic on
 * input with many unclosed opening tags: every one of them re-scans the rest of
 * the string before failing. Measured on real input, 3.4 MB of repeated
 * `<local-command-stdout>` took 108 seconds in `list` — and a transcript holds
 * whatever Claude ever read, so that input does not have to come from an
 * attacker, only from a file someone asked about.
 */
function stripSpans(text: string, tag: string): string {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  let out = "";
  let from = 0;

  for (;;) {
    const start = text.indexOf(open, from);
    if (start === -1) break;
    const end = text.indexOf(close, start + open.length);
    if (end === -1) {
      // An unclosed tag means the rest is the span: captured output that ran
      // past the scan cap, or a truncated record. Leaving it in made shell
      // output the session title - an AWS key appeared in the default `list`
      // view - so the tail goes, not the tag alone.
      return `${out}${text.slice(from, start)} `;
    }
    out += `${text.slice(from, start)} `;
    from = end + close.length;
  }

  return from === 0 ? text : out + text.slice(from);
}
const COMMAND_NAME = /<command-name>([\s\S]*?)<\/command-name>/;
const ANY_TAG = /<\/?[a-z][a-z0-9-]*>/gi;
const PASTE_PLACEHOLDER = /\[Pasted text #\d+[^\]]*\]/g;

/**
 * Pull readable human text out of a user record's content, which may be a
 * string or an array of blocks, and may be wrapped in command markup.
 */
export function extractPromptText(content: unknown): string | undefined {
  let raw: string;

  if (typeof content === "string") {
    raw = content;
  } else if (Array.isArray(content)) {
    raw = content
      .map((block) => {
        if (typeof block === "string") return block;
        if (typeof block === "object" && block !== null) {
          const b = block as { type?: unknown; text?: unknown };
          if (b.type === "text" && typeof b.text === "string") return b.text;
        }
        return "";
      })
      .join(" ");
  } else {
    return undefined;
  }

  if (raw.length > PROMPT_SCAN_CAP) raw = raw.slice(0, PROMPT_SCAN_CAP);

  // Command markup carries no user text: <command-message> is a generated
  // description and <local-command-stdout> is captured shell output.
  const withoutStdout = stripSpans(stripSpans(raw, "local-command-stdout"), "command-message");

  // A slash command is a meaningful title on its own, but only when the user
  // typed nothing else alongside it.
  const command = COMMAND_NAME.exec(withoutStdout);
  if (command?.[1]) {
    const rest = withoutStdout.replace(COMMAND_NAME, " ").replace(ANY_TAG, " ");
    if (collapse(rest) === "") return collapse(command[1]);
  }

  const cleaned = collapse(
    withoutStdout.replace(ANY_TAG, " ").replace(PASTE_PLACEHOLDER, " "),
  );
  return cleaned === "" ? undefined : cleaned;
}

function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
