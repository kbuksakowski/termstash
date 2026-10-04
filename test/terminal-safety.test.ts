import { describe, expect, it } from "vitest";
import { displayWidth, renderTable, safeText } from "../src/cli/format.js";

/**
 * A transcript holds whatever Claude ever read - a file, command output, a
 * fetched page - so bytes that act on the terminal reach this tool without
 * anyone being hostile to it. Printed raw, an escape sequence can rewrite the
 * line it sits on so a swept session displays as safe, retitle the window, or
 * on terminals that honour OSC 52 write to the clipboard.
 *
 * Every sequence below is written with escape notation rather than as literal
 * bytes, so this file stays readable in a terminal and in a diff.
 */
const ESC = "\u001b";
const BEL = "\u0007";

/** Anything that would still be able to act on a terminal. */
const DANGEROUS =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

describe("text from a transcript is data, not instructions", () => {
  it.each([
    ["colour", `${ESC}[31mred${ESC}[0m`],
    ["line rewrite", `safe${ESC}[2K\rswept`],
    ["clipboard write, OSC 52", `x${ESC}]52;c;cHduZWQ=${BEL}`],
    ["window title, OSC 0", `x${ESC}]0;taken${BEL}`],
    ["carriage return", "before\rafter"],
    ["newline", "one\ntwo"],
    ["tab", "a\tb"],
    ["C1 control", "a\u0085b"],
    ["line separator", "a\u2028b"],
    ["bidi override", "\u202etxet desrever"],
  ])("neutralises %s", (_name, input) => {
    const out = safeText(input);
    expect(out).not.toMatch(DANGEROUS);
    // Replaced, never dropped: text that quietly loses characters is its own
    // small lie, and the reader should see that something was removed.
    expect([...out]).toHaveLength([...input].length);
  });

  it("leaves ordinary text alone, accents and CJK included", () => {
    for (const text of ["Stripe webhook", "zażółć", "日本語", "a-b_c.d"]) {
      expect(safeText(text)).toBe(text);
    }
  });

  it("keeps a table aligned when a cell lies about its width", () => {
    // Counted raw, the escape sequence is nine columns that are not there, and
    // every column after it would be pushed sideways. trimEnd means the rows
    // differ in length, so what has to match is where column two begins.
    const rows = [
      ["aaa", `${ESC}[31mPWNED${ESC}[0m`],
      ["bbb", "plain"],
    ];
    const [, first, second] = renderTable(
      [{ header: "X" }, { header: "Y" }],
      rows,
      80,
    );

    expect(first).not.toMatch(DANGEROUS);
    expect(first?.indexOf("\ufffd")).toBe(second?.indexOf("plain"));
  });
});
