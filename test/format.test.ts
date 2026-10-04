import { describe, expect, it } from "vitest";
import { displayWidth, relativeTime, renderTable, truncate } from "../src/cli/format.js";

const NOW = new Date("2026-09-12T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);

describe("relativeTime", () => {
  it("describes recent and distant times", () => {
    expect(relativeTime(ago(30_000), NOW)).toBe("just now");
    expect(relativeTime(ago(12 * 60_000), NOW)).toBe("12m ago");
    expect(relativeTime(ago(3 * 3_600_000), NOW)).toBe("3h ago");
    expect(relativeTime(ago(86_400_000), NOW)).toBe("yesterday");
    expect(relativeTime(ago(14 * 86_400_000), NOW)).toBe("14d ago");
    expect(relativeTime(ago(90 * 86_400_000), NOW)).toBe("3mo ago");
  });

  it("does not produce negative ages from clock skew", () => {
    expect(relativeTime(new Date(NOW.getTime() + 60_000), NOW)).toBe("just now");
  });
});

describe("displayWidth", () => {
  it("counts wide characters as two columns", () => {
    expect(displayWidth("abc")).toBe(3);
    expect(displayWidth("日本語")).toBe(6);
  });

  it("handles accented Latin as single width", () => {
    expect(displayWidth("zażółć")).toBe(6);
  });
});

describe("truncate", () => {
  it("leaves short text alone", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  it("adds an ellipsis within the budget", () => {
    const out = truncate("a very long session title indeed", 10);
    expect(displayWidth(out)).toBeLessThanOrEqual(10);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("renderTable stays inside the terminal", () => {
  const columns = [
    { header: "", min: 2 },
    { header: "ID", min: 6 },
    { header: "PROJECT", min: 8 },
    { header: "UPDATED", min: 9 },
    { header: "SESSION", flex: 1, min: 20 },
  ];

  it("caps a column whose widest cell is absurd", () => {
    // `projectName` is `basename(cwd)` read out of a transcript, and the
    // PROJECT column has no flex, so one session with a 300,000-character cwd
    // produced 300,000-column rows in a 100-column terminal - and padding
    // every other row to match cost gigabytes of RSS.
    const rows = [[" ", "aaaaaa", "w".repeat(300_000), "just now", "hi"]];
    const lines = renderTable(columns, rows, 100);

    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(100);
  });

  it("fits even when several columns are over-wide at once", () => {
    const rows = [["x".repeat(500), "y".repeat(500), "z".repeat(500), "w".repeat(500), "q".repeat(500)]];
    const lines = renderTable(columns, rows, 80);

    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(80);
  });

  it("still lets an ordinary table use the room it needs", () => {
    const rows = [
      [" ", "aaaaaa", "backend_api", "just now", "the stripe webhook retry logic"],
      ["★", "bbbbbb", "web", "2h ago", "fix the flaky test"],
    ];
    const lines = renderTable(columns, rows, 100);

    expect(lines[1]).toContain("backend_api");
    expect(lines[1]).toContain("the stripe webhook retry logic");
  });
});
