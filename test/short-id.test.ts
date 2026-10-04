import { describe, expect, it } from "vitest";
import { assignShortIds, resolveShortId } from "../src/core/short-id/index.js";

describe("assignShortIds", () => {
  it("uses six characters when that is unambiguous", () => {
    const ids = ["7f31a2aa-0000-4000-8000-000000000000", "91bc22bb-0000-4000-8000-000000000000"];
    const map = assignShortIds(ids);
    expect(map.get(ids[0]!)).toBe("7f31a2");
    expect(map.get(ids[1]!)).toBe("91bc22");
  });

  it("widens only the ids that actually collide", () => {
    const a = "7f31a2aa-0000-4000-8000-000000000000";
    const b = "7f31a2bb-0000-4000-8000-000000000000";
    const c = "91bc22cc-0000-4000-8000-000000000000";
    const map = assignShortIds([a, b, c]);
    expect(map.get(a)).toBe("7f31a2a");
    expect(map.get(b)).toBe("7f31a2b");
    expect(map.get(c)).toBe("91bc22");
  });

  it("never assigns the same short id twice", () => {
    const ids = Array.from({ length: 200 }, (_, i) =>
      `${i.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`,
    );
    const values = [...assignShortIds(ids).values()];
    expect(new Set(values).size).toBe(values.length);
  });
});

describe("resolveShortId", () => {
  const a = "7f31a2aa-0000-4000-8000-000000000000";
  const b = "7f31a2bb-0000-4000-8000-000000000000";
  const c = "91bc22cc-0000-4000-8000-000000000000";

  it("matches a full id exactly", () => {
    expect(resolveShortId([a, b], a)).toEqual({ status: "unique", id: a });
  });

  it("matches an unambiguous prefix", () => {
    expect(resolveShortId([a, c], "91bc")).toEqual({ status: "unique", id: c });
  });

  it("reports every candidate rather than picking one", () => {
    const result = resolveShortId([a, b, c], "7f31a2");
    expect(result.status).toBe("ambiguous");
    if (result.status === "ambiguous") expect(result.candidates.sort()).toEqual([a, b].sort());
  });

  it("reports none for a miss, blank input, or an empty set", () => {
    expect(resolveShortId([a], "zzzz")).toEqual({ status: "none" });
    expect(resolveShortId([a], "  ")).toEqual({ status: "none" });
    expect(resolveShortId([], a)).toEqual({ status: "none" });
  });

  it("ignores case and surrounding whitespace", () => {
    expect(resolveShortId([a], "  7F31A2  ")).toEqual({ status: "unique", id: a });
  });
});
