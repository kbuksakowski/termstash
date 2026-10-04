import { readFile } from "node:fs/promises";
import { openUserFile } from "../../core/fs/user-file.js";
import { openRegularFile } from "../../core/fs/regular.js";
import type { Retention, SessionOrigin } from "../../core/session/types.js";
import { userSettingsFile } from "./paths.js";

/**
 * Claude Code's own values: transcripts are swept after 30 days unless
 * `cleanupPeriodDays` in settings.json says otherwise, and 1 is the smallest
 * value it accepts. Taken from Claude Code's documentation and confirmed on a
 * real machine - see TECHNICAL-SPIKE.md. PRD v0.2 section 6.6.
 */
export const DEFAULT_CLEANUP_PERIOD_DAYS = 30;
export const MIN_CLEANUP_PERIOD_DAYS = 1;
export const DEFAULT_WARNING_WINDOW_DAYS = 7;

const MS_PER_DAY = 86_400_000;

export type RetentionPolicy = {
  /** Undefined means we could not determine it safely - never guess. */
  cleanupPeriodDays?: number;
  warningWindowDays: number;
  reason?: string;
};

/**
 * Resolve the effective retention period.
 *
 * Managed settings can override this and are not readable here, so a resolved
 * value is a best estimate. That is why section 24 forbids stating a deadline
 * and requires "approaching" wording instead.
 */
export async function readRetentionPolicy(
  root: string,
  warningWindowDays = DEFAULT_WARNING_WINDOW_DAYS,
): Promise<RetentionPolicy> {
  let raw: string;
  try {
    // A FIFO or a device at settings.json parked `list` and `doctor` inside
    // open() until they were killed. Absent and not-an-ordinary-file get the
    // same answer here: Claude's own default applies.
    const handle = await openUserFile(userSettingsFile(root));
    if (handle === undefined) {
      return { cleanupPeriodDays: DEFAULT_CLEANUP_PERIOD_DAYS, warningWindowDays };
    }
    try {
      raw = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    // No settings file is the common case: Claude's own default applies.
    return { cleanupPeriodDays: DEFAULT_CLEANUP_PERIOD_DAYS, warningWindowDays };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      warningWindowDays,
      reason: "settings.json could not be parsed, so the retention period is unknown",
    };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return { warningWindowDays, reason: "settings.json has an unexpected shape" };
  }

  const configured = (parsed as { cleanupPeriodDays?: unknown }).cleanupPeriodDays;
  if (configured === undefined) {
    return { cleanupPeriodDays: DEFAULT_CLEANUP_PERIOD_DAYS, warningWindowDays };
  }
  if (
    typeof configured !== "number" ||
    !Number.isInteger(configured) ||
    configured < MIN_CLEANUP_PERIOD_DAYS
  ) {
    // Claude rejects these too, and pauses its sweep rather than guessing.
    return {
      warningWindowDays,
      reason: `cleanupPeriodDays is set to an invalid value (${String(configured)})`,
    };
  }

  return { cleanupPeriodDays: configured, warningWindowDays };
}

/**
 * Conservative by design. PRD section 24: a false "expires soon" is worse than
 * admitting we do not know, because it pushes people to act on a deadline that
 * may not exist. Desktop and Cowork sessions are exempt at any age and we
 * cannot currently identify them, so anything we cannot classify is unknown.
 */
export function assessRetention(
  mtime: Date,
  origin: SessionOrigin,
  policy: RetentionPolicy,
  now: Date = new Date(),
): Retention {
  const ageDays = Math.max(0, (now.getTime() - mtime.getTime()) / MS_PER_DAY);
  const rounded = Math.floor(ageDays);

  if (origin === "unknown") {
    return {
      status: "unknown",
      ageDays: rounded,
      reason: "session origin could not be determined, so the sweep may not apply",
    };
  }

  if (policy.cleanupPeriodDays === undefined) {
    return {
      status: "unknown",
      ageDays: rounded,
      reason: policy.reason ?? "the retention period could not be determined",
    };
  }

  const daysLeft = Math.max(0, Math.ceil(policy.cleanupPeriodDays - ageDays));
  const atRisk = ageDays >= policy.cleanupPeriodDays - policy.warningWindowDays;

  return {
    status: atRisk ? "at-risk" : "ok",
    ageDays: rounded,
    estimatedDaysLeft: daysLeft,
  };
}
