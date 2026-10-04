import { describe, expect, it } from "vitest";
import {
  DEFAULT_CLEANUP_PERIOD_DAYS,
  assessRetention,
  readRetentionPolicy,
} from "../src/adapters/claude/retention.js";
import { root, writeSettings } from "./helpers/sandbox.js";

const NOW = new Date("2026-09-12T12:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

describe("readRetentionPolicy", () => {
  it("falls back to Claude's default when there is no settings file", async () => {
    const policy = await readRetentionPolicy(root());
    expect(policy.cleanupPeriodDays).toBe(DEFAULT_CLEANUP_PERIOD_DAYS);
  });

  it("uses a configured value", async () => {
    await writeSettings({ cleanupPeriodDays: 90 });
    expect((await readRetentionPolicy(root())).cleanupPeriodDays).toBe(90);
  });

  it("reports unknown rather than guessing when settings cannot be parsed", async () => {
    await writeSettings("{ broken");
    const policy = await readRetentionPolicy(root());
    expect(policy.cleanupPeriodDays).toBeUndefined();
    expect(policy.reason).toMatch(/could not be parsed/);
  });

  it("treats an invalid period as undeterminable, matching Claude's own refusal", async () => {
    await writeSettings({ cleanupPeriodDays: 0 });
    expect((await readRetentionPolicy(root())).cleanupPeriodDays).toBeUndefined();
  });
});

describe("assessRetention", () => {
  const policy = { cleanupPeriodDays: 30, warningWindowDays: 7 };

  it("is ok well inside the window", () => {
    const result = assessRetention(daysAgo(2), "interactive", policy, NOW);
    expect(result.status).toBe("ok");
    expect(result.estimatedDaysLeft).toBe(28);
  });

  it("flags a session inside the warning window", () => {
    expect(assessRetention(daysAgo(25), "interactive", policy, NOW).status).toBe("at-risk");
  });

  it("treats sdk sessions as swept, because they are", () => {
    expect(assessRetention(daysAgo(25), "sdk-cli", policy, NOW).status).toBe("at-risk");
  });

  it("refuses to judge a session whose origin is unknown", () => {
    // Desktop and Cowork transcripts are exempt at any age and we cannot
    // identify them, so a warning here would be a false deadline.
    const result = assessRetention(daysAgo(400), "unknown", policy, NOW);
    expect(result.status).toBe("unknown");
    expect(result.reason).toMatch(/origin/);
  });

  it("refuses to judge when the period is undeterminable", () => {
    const result = assessRetention(daysAgo(25), "interactive", { warningWindowDays: 7 }, NOW);
    expect(result.status).toBe("unknown");
  });
});
