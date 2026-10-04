import { describe, expect, it, vi } from "vitest";
import { headline } from "../src/cli/doctor.js";
import type { DoctorReport } from "../src/core/doctor/types.js";

/**
 * The sentences a first run leads with. Every branch is pinned, because the
 * first draft of this wording said "none of them has no archive" and, for a
 * single unarchived session, "It is archived" - the one claim this tool must
 * never get backwards.
 */

function render(h: DoctorReport["headline"], scanPartial = false): string {
  const lines: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((c) => (lines.push(String(c)), true));
  headline({ sessionCount: 1, archiveCount: 0, scanPartial, headline: h, findings: [] });
  vi.restoreAllMocks();
  return lines.join("");
}

describe("doctor's headline", () => {
  it("leads with the lost count and the at-risk count", () => {
    const text = render({ lost: 1878, atRisk: 48, atRiskWithoutArchive: 48 });
    expect(text).toContain("At least 1878 sessions are no longer resumable.");
    expect(text).toContain("48 more are approaching Claude's retention cutoff.");
    expect(text).toContain("None of them is archived.");
    expect(text).toContain("termstash pin <id>");
  });

  it("never says a single unarchived session is archived", () => {
    const text = render({ lost: 0, atRisk: 1, atRiskWithoutArchive: 1 });
    expect(text).toContain("1 is approaching");
    expect(text).toContain("It is not archived.");
    expect(text).not.toMatch(/It is archived/);
  });

  it("says when every at-risk session is archived, and offers no pin", () => {
    const text = render({ lost: 0, atRisk: 3, atRiskWithoutArchive: 0 });
    expect(text).toContain("All of them are archived.");
    expect(text).not.toContain("termstash pin");
  });

  it("counts a partial set of archives", () => {
    expect(render({ lost: 0, atRisk: 5, atRiskWithoutArchive: 2 })).toContain("2 of them are not archived.");
    expect(render({ lost: 0, atRisk: 5, atRiskWithoutArchive: 1 })).toContain("1 of them is not archived.");
  });

  it("does not claim sessions are gone when it could not look everywhere", () => {
    const text = render({ lost: 1878, atRisk: 0, atRiskWithoutArchive: 0 }, true);
    expect(text).not.toContain("no longer resumable");
  });

  it("agrees in number for a single lost session", () => {
    expect(render({ lost: 1, atRisk: 0, atRiskWithoutArchive: 0 })).toContain("Its transcript is gone");
  });

  it("prints nothing when there is nothing to lead with", () => {
    expect(render({ lost: 0, atRisk: 0, atRiskWithoutArchive: 0 })).toBe("");
  });

  it("leaves no trailing spaces on the blank line", () => {
    expect(render({ lost: 5, atRisk: 2, atRiskWithoutArchive: 2 })).not.toMatch(/ +\n/);
  });
});
