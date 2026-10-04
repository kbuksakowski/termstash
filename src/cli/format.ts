/** Terminal rendering helpers. No dependencies: PRD v0.2 principle. */

const MS = { minute: 60_000, hour: 3_600_000, day: 86_400_000 } as const;

export function relativeTime(value: Date, now: Date = new Date()): string {
  // A manifest is input, and an unparseable `sourceMtime` reached here as an
  // Invalid Date, fell through every branch and printed "NaNy ago".
  if (Number.isNaN(value.getTime())) return "at an unknown time";
  const delta = now.getTime() - value.getTime();
  if (delta < 0) return "just now";
  if (delta < MS.minute) return "just now";
  if (delta < MS.hour) return `${Math.floor(delta / MS.minute)}m ago`;
  if (delta < MS.day) return `${Math.floor(delta / MS.hour)}h ago`;
  const days = Math.floor(delta / MS.day);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return months < 12 ? `${months}mo ago` : `${Math.floor(days / 365)}y ago`;
}

/**
 * Display width, not code-unit length. Titles are user text and routinely
 * contain CJK or emoji, which occupy two columns and would otherwise skew
 * every column to their right.
 */
/**
 * Walk text as the terminal paints it: a base character and the zero-width
 * marks that belong to it, together, with the width of the pair.
 *
 * Measuring and truncating have to agree, and they did not. `displayWidth`
 * learned that a variation selector widens the character before it; `truncate`
 * kept asking `displayWidth` one character at a time, where a lookahead can
 * see nothing. So the cap was computed correctly and then applied by a loop
 * that under-counted every ❤️ and every keycap by half, and the 166-column row
 * came back.
 */
function* clusters(text: string): Generator<{ text: string; width: number }> {
  const points = [...text];
  for (let i = 0; i < points.length; i += 1) {
    const point = points[i] ?? "";
    const code = point.codePointAt(0) ?? 0;
    if (isZeroWidth(code)) continue;

    let cluster = point;
    let wide = isWide(code);
    // Absorb the marks that follow, including the variation selector that
    // decides whether this is an emoji and therefore two columns.
    while (i + 1 < points.length) {
      const next = points[i + 1] ?? "";
      const nextCode = next.codePointAt(0) ?? 0;
      if (!isZeroWidth(nextCode)) break;
      if (nextCode === 0xfe0f) wide = true;
      cluster += next;
      i += 1;
    }
    yield { text: cluster, width: wide ? 2 : 1 };
  }
}

export function displayWidth(text: string): number {
  let width = 0;
  for (const cluster of clusters(text)) width += cluster.width;
  return width;
}

/**
 * Code points that occupy no column.
 *
 * Hand-picked ranges got this wrong in both directions. Devanagari and Thai
 * *spacing* marks were listed as zero-width — they are Mc, they take a column,
 * and measuring them as nothing meant `truncate` never fired: a title of 6,000
 * matras rendered as a 4,162-column row in a 100-column terminal. Meanwhile
 * marks outside the picked ranges — the Hebrew shin dot, most of Arabic,
 * Bengali, Tamil — were charged a column they do not take, so the very text
 * the previous fix claimed to have fixed was still mismeasured.
 *
 * Unicode has the answer and so does the regex engine: Mn and Me are
 * non-spacing and enclosing, Mc is spacing. Asking the standard removes a
 * category of mistake rather than one more range of it.
 */
const NON_SPACING = /[\p{Mn}\p{Me}]/u;

function isZeroWidth(code: number): boolean {
  // The two joiners are Cf, not marks, and they paint nothing.
  if (code === 0x200c || code === 0x200d) return true;
  return NON_SPACING.test(String.fromCodePoint(code));
}

/**
 * Two columns wide in a terminal.
 *
 * The emoji planes were covered by one range, U+1F300–1F9FF, which leaves out
 * everything added since: U+1FA70–1FAFF (🫠, 🩸), U+1F000–1F2FF (🀄, 🆎) and
 * the East-Asian-Wide singletons scattered through the BMP (⌚, ⚡, ✅, ⭐).
 * Each of those was measured as one column and painted as two, so a title made
 * of them produced a 166-column row in a 100-column terminal — defeating the
 * column cap entirely.
 */
function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2329 && code <= 0x232a) ||
    (code >= 0x231a && code <= 0x231b) ||
    (code >= 0x23e9 && code <= 0x23ec) ||
    code === 0x23f0 ||
    code === 0x23f3 ||
    (code >= 0x25fd && code <= 0x25fe) ||
    (code >= 0x2614 && code <= 0x2615) ||
    (code >= 0x2648 && code <= 0x2653) ||
    code === 0x267f ||
    code === 0x2693 ||
    code === 0x26a1 ||
    (code >= 0x26aa && code <= 0x26ab) ||
    (code >= 0x26bd && code <= 0x26be) ||
    (code >= 0x26c4 && code <= 0x26c5) ||
    code === 0x26ce ||
    code === 0x26d4 ||
    code === 0x26ea ||
    (code >= 0x26f2 && code <= 0x26f3) ||
    code === 0x26f5 ||
    code === 0x26fa ||
    code === 0x26fd ||
    code === 0x2705 ||
    (code >= 0x270a && code <= 0x270b) ||
    code === 0x2728 ||
    code === 0x274c ||
    code === 0x274e ||
    (code >= 0x2753 && code <= 0x2755) ||
    code === 0x2757 ||
    (code >= 0x2795 && code <= 0x2797) ||
    code === 0x27b0 ||
    code === 0x27bf ||
    (code >= 0x2b1b && code <= 0x2b1c) ||
    code === 0x2b50 ||
    code === 0x2b55 ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xa960 && code <= 0xa97f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x16fe0 && code <= 0x16fe4) || // Tangut/Nushu/Khitan iteration marks
    (code >= 0x16ff0 && code <= 0x16ff1) ||
    (code >= 0x17000 && code <= 0x187f7) || // Tangut
    (code >= 0x18800 && code <= 0x18cd5) ||
    (code >= 0x18d00 && code <= 0x18d08) || // Tangut components supplement
    (code >= 0x1aff0 && code <= 0x1b167) || // Kana extended
    (code >= 0x1b170 && code <= 0x1b2fb) || // Nushu
    (code >= 0x1f000 && code <= 0x1f0ff) ||
    (code >= 0x1f18e && code <= 0x1f19a) ||
    (code >= 0x1f1e6 && code <= 0x1f1ff) ||
    (code >= 0x1f200 && code <= 0x1f2ff) ||
    (code >= 0x1f300 && code <= 0x1f9ff) ||
    (code >= 0x1fa70 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

import { safeBlock, safeText } from "../core/text/safe.js";

export { safe, safeBlock, safeText } from "../core/text/safe.js";

/**
 * Text safety, below the rendering layer.
 *
 * It lived in the CLI's formatter, which meant the core could not compose a
 * message safely without importing upward. The core does compose messages -
 * `restoreArchive` builds refusal reasons out of filesystem paths - and a path
 * component is a readdir name, which can contain a newline. That one
 * unreachable primitive was the last way to print a forged
 * "✓ Session restored and verified" block inside a failure.
 */

/**
 * Hard ceiling on characters, whatever they measure.
 *
 * Combining marks count as zero width, so a title made of 200,000 of them has
 * a display width of 2 and used to pass through untouched - one table row,
 * 200,000 characters long.
 */
const MAX_CHARS = 4096;

export function truncate(text: string, max: number): string {
  // Sliced by code point, not code unit: `text.slice` could cut a surrogate
  // pair in half and leave a lone surrogate, which Node's UTF-8 encoder then
  // turns into U+FFFD - a replacement character the text never contained.
  const capped =
    text.length > MAX_CHARS ? [...text].slice(0, MAX_CHARS).join("") : text;
  const safe = safeText(capped);
  if (max <= 0) return "";
  if (displayWidth(safe) <= max) return safe;
  let out = "";
  let width = 0;
  for (const cluster of clusters(safe)) {
    const next = width + cluster.width;
    if (next > max - 1) break;
    out += cluster.text;
    width = next;
  }
  return `${out}…`;
}

export function padEnd(text: string, width: number): string {
  const missing = width - displayWidth(text);
  return missing > 0 ? text + " ".repeat(missing) : text;
}

export type Column = {
  header: string;
  /** Columns with a weight absorb leftover width; the rest size to content. */
  flex?: number;
  min?: number;
};

export function renderTable(
  columns: readonly Column[],
  rows: readonly string[][],
  totalWidth: number,
): string[] {
  const gap = 2;
  // Sanitise before measuring: an escape sequence counted as visible width
  // would push every other column out of alignment.
  rows = rows.map((row) => row.map(safeText));
  const gaps = gap * Math.max(0, columns.length - 1);
  const mins = columns.map((column) => column.min ?? 0);
  const minTotal = mins.reduce((sum, value) => sum + value, 0);

  const natural = columns.map((column, index) => {
    const cells = rows.map((row) => displayWidth(row[index] ?? ""));
    const want = Math.max(displayWidth(column.header), ...cells, column.min ?? 0);
    if (column.flex) return want;
    // A column without flex used to take whatever its widest cell wanted, and
    // `projectName` is `basename(cwd)` read out of a transcript - so one
    // session with a 300,000-character cwd produced 300,000-column rows in a
    // 100-column terminal, and the padding to match cost gigabytes. A column
    // may only grow into room that actually exists beside the others.
    const room = totalWidth - gaps - (minTotal - (column.min ?? 0));
    return Math.min(want, Math.max(column.min ?? 0, room));
  });

  const fixed = natural.reduce((sum, width, index) => {
    return columns[index]?.flex ? sum : sum + width;
  }, 0);
  const flexTotal = columns.reduce((sum, column) => sum + (column.flex ?? 0), 0);
  const available = Math.max(0, totalWidth - fixed - gaps);

  const widths = natural.map((width, index) => {
    const column = columns[index];
    if (!column?.flex) return width;
    const share = Math.floor((available * column.flex) / flexTotal);
    return Math.max(column.min ?? 0, Math.min(width, share));
  });

  // Two over-wide columns can each pass the check above and still not fit
  // together. Give the surplus back, widest first, never below a minimum.
  let over = widths.reduce((sum, width) => sum + width, 0) + gaps - totalWidth;
  while (over > 0) {
    let widest = -1;
    for (let i = 0; i < widths.length; i += 1) {
      const current = widths[i] ?? 0;
      if (current <= (mins[i] ?? 0)) continue;
      if (widest === -1 || current > (widths[widest] ?? 0)) widest = i;
    }
    if (widest === -1) break; // everything is already at its minimum
    widths[widest] = (widths[widest] ?? 0) - 1;
    over -= 1;
  }

  const line = (cells: readonly string[]) =>
    cells
      .map((cell, index) => padEnd(truncate(cell, widths[index] ?? 0), widths[index] ?? 0))
      .join(" ".repeat(gap))
      .trimEnd();

  return [line(columns.map((c) => c.header)), ...rows.map(line)];
}

export function terminalWidth(stream: NodeJS.WriteStream = process.stdout): number {
  const columns = stream.columns ?? 0;
  return columns > 0 ? Math.min(columns, 160) : 100;
}

/**
 * A value the user typed, made safe to print back at them.
 *
 * Error messages echo the id that was not found, and an id is whatever was on
 * the command line: escape sequences that act on the terminal, or a megabyte of
 * text that scrolls the failure off the screen. Both stop here.
 */
export function quoted(value: string): string {
  return `"${truncate(value, 60)}"`;
}


/**
 * The only way this tool writes to a terminal.
 *
 * `safeText` was applied per site, and the escape-injection fix reached most
 * of them: `restore` sanitised one path and printed `manifest.projectPath`
 * raw nine lines below it, and `resume` was never touched at all, so a
 * transcript-controlled `cwd` set the window title and erased the line it was
 * printed on. Per-site means someone has to remember, and the people who
 * forgot were the ones who had just written the fix.
 *
 * Sanitising in the writer removes the need to remember. A new message is safe
 * because of where it goes, not because of what its author knew.
 */
export function out(text: string): void {
  process.stdout.write(safeBlock(text));
}

export function err(text: string): void {
  process.stderr.write(safeBlock(text));
}

/**
 * Machine-readable output, escaped so it cannot act on a terminal either.
 *
 * `--json` is piped to `jq` and also read straight on screen. `JSON.stringify`
 * escapes control characters but not U+202E and friends, so the second use was
 * still a way for a transcript to reorder what a reader sees. Escaping every
 * non-ASCII code point keeps the bytes a parser receives exactly equivalent -
 * `‮` is the same string to `JSON.parse` - while leaving nothing for a
 * terminal to interpret. The data is not altered, only spelled differently.
 */
export function jsonOut(value: unknown): void {
  const json = JSON.stringify(value, null, 2) ?? "null";
  let escaped = "";
  for (const char of json) {
    const code = char.codePointAt(0) ?? 0;
    // DEL is below 0x80 and `JSON.stringify` only escapes U+0000-001F, so it
    // was the one code point this file calls dangerous that `--json` emitted raw.
    if (code < 0x80 && code !== 0x7f) {
      escaped += char;
      continue;
    }
    for (let i = 0; i < char.length; i += 1) {
      escaped += `\\u${char.charCodeAt(i).toString(16).padStart(4, "0")}`;
    }
  }
  process.stdout.write(`${escaped}\n`);
}
