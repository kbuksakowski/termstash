import { discoverSessions } from "../adapters/claude/discover.js";
import { describeError } from "../core/text/safe.js";
import { protectionState } from "../core/archive/protection.js";
import { listArchives } from "../core/archive/store.js";
import { readMetadata } from "../core/metadata/store.js";
import type { ProtectionState } from "../core/metadata/store.js";
import { termstashRoot } from "../core/paths.js";
import type { Session } from "../core/session/types.js";
import { assignShortIds } from "../core/short-id/index.js";
import { allSessions } from "./sessions.js";
import type { ParsedArgs } from "./args.js";
import { flagBool, flagNumber, flagString } from "./args.js";
import { err, jsonOut, out, relativeTime, renderTable, safe, safeText, terminalWidth } from "./format.js";

export async function listCommand(args: ParsedArgs, now = new Date()): Promise<number> {
  // Archives included: a pinned session used to disappear from here the moment
  // Claude swept it, which is the one moment the star was for.
  const { sessions, unreadable, archivesUnreadable, refusedArchives } = await allSessions({
    root: termstashRoot(),
    discover: () => discoverSessions({ now }),
  });
  const overlay = await readOverlay(sessions);
  const protection = overlay.protection;

  const project = flagString(args, "project");
  const limit = flagNumber(args, "limit");

  let visible = sessions;
  if (project !== undefined) {
    const needle = project.toLowerCase();
    visible = visible.filter(
      (s) =>
        s.projectName?.toLowerCase().includes(needle) ||
        s.projectPath?.toLowerCase().includes(needle) ||
        s.projectDirName.toLowerCase().includes(needle),
    );
  }
  if (flagBool(args, "live")) visible = visible.filter((s) => s.isLive);
  if (flagBool(args, "pinned")) {
    visible = visible.filter((s) => protection.get(s.id) !== undefined && protection.get(s.id) !== "unprotected");
  }
  let undeterminable = 0;
  if (flagBool(args, "at-risk")) {
    // A session Claude has already swept is past being at risk, not at risk.
    undeterminable = visible.filter(
      (s) => s.archivedOnly !== true && s.retention.status === "unknown",
    ).length;
    visible = visible.filter((s) => s.archivedOnly !== true && s.retention.status === "at-risk");
  }
  if (limit !== undefined) visible = visible.slice(0, limit);

  if (flagBool(args, "json")) {
    const payload = visible.map((session) => {
      const own = overlay.titles.get(session.id);
      return {
        ...session,
        ...(own !== undefined ? { title: own, titleSource: "termstash" as const } : {}),
        ...(own !== undefined ? { claudeTitle: session.title } : {}),
        protectionState: protection.get(session.id) ?? "unprotected",
      };
    });
    // An envelope, not the bare array this used to print. Every warning below
    // goes to stderr, which a script does not read, and the exit code is 0
    // whether or not half of Claude's storage could be opened - so `--json`
    // was the one output that could not say "this list is a floor". Its two
    // siblings already could: `search --json` carries `searched`, `doctor
    // --json` carries `scanPartial`. The PRD asks of this flag that "a human
    // can check what TermStash actually read"; an array cannot answer that.
    jsonOut({
      sessions: payload,
      searched: {
        scanPartial: unreadable.length > 0,
        unreadableLocations: unreadable.map((entry) => entry.path),
        ...(archivesUnreadable !== undefined ? { archivesUnreadable } : {}),
        refusedArchives,
        undeterminableRetention: undeterminable,
        ...(overlay.error !== undefined ? { metadataUnreadable: overlay.error } : {}),
        rejectedMetadataEntries: overlay.rejected,
      },
    });
    // A script got "nothing is protected" and a list presented as complete,
    // while the human form said both facts out loud on stderr. The first pass
    // at this added three of the four reporters and left out the one that says
    // no deadline could be computed at all - so `--at-risk --json` still
    // answered `[]` where `--at-risk` said it could not judge anything.
    reportUndeterminable(undeterminable);
    reportArchiveTrouble(archivesUnreadable, refusedArchives);
    reportOverlayError(overlay);
    reportRejected(overlay);
    reportUnreadable(unreadable);
    return 0;
  }

  if (visible.length === 0) {
    // "None found" and "none that could be reached" are different facts about
    // someone's data, and the reason printed below was easy to read as detail
    // rather than as the correction it is.
    out(
      sessions.length > 0
        ? "No sessions match those filters.\n"
        : unreadable.length > 0 || archivesUnreadable !== undefined || refusedArchives.length > 0
          ? "No Claude Code sessions could be read.\n"
          : "No Claude Code sessions found.\n",
    );
    reportUndeterminable(undeterminable);
    reportArchiveTrouble(archivesUnreadable, refusedArchives);
    reportOverlayError(overlay);
    reportRejected(overlay);
    reportUnreadable(unreadable);
    return 0;
  }

  // Over every session, not over what survived the filters. `--project` or
  // `--limit` narrowed the candidate set, so `list` printed `abcdef` where
  // `resume abcdef` answers "matches 2 sessions" - the ambiguous abbreviation
  // the README says is refused rather than guessed.
  const shortIds = assignShortIds(sessions.map((s) => s.id));
  const rows = visible.map((session) => [
    marker(session, protection.get(session.id) ?? "unprotected"),
    shortIds.get(session.id) ?? session.id,
    session.projectName ?? "—",
    relativeTime(session.updatedAt, now),
    overlay.titles.get(session.id) ?? session.title ?? "—",
  ]);

  const lines = renderTable(
    [
      { header: "", min: 2 },
      { header: "ID", min: 6 },
      { header: "PROJECT", min: 8 },
      { header: "UPDATED", min: 9 },
      { header: "SESSION", flex: 1, min: 20 },
    ],
    rows,
    terminalWidth(),
  );

  out(`\nClaude Code sessions\n\n`);
  for (const line of lines) out(safe`${line}\n`);
  out(safe`\n${summary(visible, sessions.length, protection)}\n`);
  reportUndeterminable(undeterminable);
  reportArchiveTrouble(archivesUnreadable, refusedArchives);
  reportOverlayError(overlay);
  reportRejected(overlay);
  reportUnreadable(unreadable);
  return 0;
}

/**
 * Two independent facts, two characters: what protection the session has, and
 * what state it is in. Collapsing them into one marker would hide whichever
 * lost, and a pinned session that is also about to be swept needs both.
 *
 * A hollow star means pinned but not actually preserved as it stands - either
 * the archive fell behind or there is none (PRD v0.2 sections 12 and 17.1).
 */
function marker(session: Session, protection: ProtectionState): string {
  const preserved =
    protection === "protected-current" ? "★" : protection === "protected-stale" ? "☆" : " ";
  const state = session.isLive
    ? "●"
    : session.archivedOnly === true
      ? "▪"
      : session.retention.status === "at-risk"
        ? "⚠"
        : session.retention.status === "unknown"
          ? "?"
          : " ";
  return safe`${preserved}${state}`.trimEnd();
}

/**
 * What TermStash knows about these sessions that Claude does not: protection,
 * and titles the user set here.
 *
 * Protection is recomputed every time; a cached "protected" that stopped being
 * true is a lie.
 */
export type Overlay = {
  protection: Map<string, ProtectionState>;
  titles: Map<string, string>;
  /** Entries the metadata reader refused. Their pins and titles are not in effect. */
  rejected: number;
  /**
   * Why there is no overlay, when there should have been one.
   *
   * An unreadable metadata file used to be swallowed here, so every pin
   * vanished from `list` without a word and `list --pinned` went further and
   * asserted there were none. Only `doctor` knew. A command that cannot see
   * the pins has to say so where it would have shown them.
   */
  error?: string;
};

export async function readOverlay(sessions: readonly Session[]): Promise<Overlay> {
  const root = termstashRoot();
  const states = new Map<string, ProtectionState>();
  const titles = new Map<string, string>();

  let pinned: Set<string>;
  let rejected = 0;
  try {
    const metadata = await readMetadata(root);
    rejected = Object.keys(metadata.rejected ?? {}).length;
    for (const entry of Object.values(metadata.sessions)) {
      if (entry.title !== undefined && entry.title !== "") titles.set(entry.sessionId, entry.title);
    }
    pinned = new Set(
      Object.values(metadata.sessions)
        .filter((entry) => entry.pinned === true)
        .map((entry) => entry.sessionId),
    );
  } catch (error) {
    // An unreadable metadata file must not take `list` down with it - and must
    // not pass unmentioned either.
    return {
      protection: states,
      titles,
      rejected: 0,
      error: describeError(error),
    };
  }
  if (pinned.size === 0) return { protection: states, titles, rejected };

  const archives = new Map((await listArchives(root)).map((a) => [a.sessionId, a]));
  for (const session of sessions) {
    if (!pinned.has(session.id)) continue;
    const archive = archives.get(session.id);
    states.set(
      session.id,
      protectionState({
        pinned: true,
        ...(archive !== undefined ? { manifest: archive.manifest } : {}),
        // An archive-backed session has no live transcript, and passing the
        // archive's own numbers as `live` made `protectionState` compare the
        // archive against itself through `isStale`. A manifest with an
        // unparseable `sourceMtime` then read as stale, so `list` showed ☆
        // while `doctor` - which gets this right - showed nothing wrong.
        ...(session.archivedOnly === true
          ? {}
          : { live: { sizeBytes: session.sizeBytes, mtime: session.updatedAt } }),
      }),
    );
  }
  return { protection: states, titles, rejected };
}

function summary(
  visible: readonly Session[],
  total: number,
  pinnedStates: Map<string, ProtectionState>,
): string {
  const parts = [safe`${visible.length} of ${total} session${total === 1 ? "" : "s"}`];
  const protectedCount = visible.filter((s) => pinnedStates.get(s.id) === "protected-current").length;
  const staleCount = visible.filter((s) => pinnedStates.get(s.id) === "protected-stale").length;
  if (protectedCount > 0) parts.push(safe`★ ${protectedCount} protected`);
  if (staleCount > 0) parts.push(safe`☆ ${staleCount} pinned but NOT protected`);
  const live = visible.filter((s) => s.isLive).length;
  const swept = visible.filter((s) => s.archivedOnly === true).length;
  const atRisk = visible.filter((s) => s.retention.status === "at-risk").length;
  const unknown = visible.filter((s) => s.archivedOnly !== true && s.retention.status === "unknown").length;
  if (live > 0) parts.push(safe`● ${live} live`);
  if (swept > 0) parts.push(safe`▪ ${swept} swept by Claude — restore to resume`);
  if (atRisk > 0) parts.push(safe`⚠ ${atRisk} approaching Claude's retention cutoff`);
  if (unknown > 0) parts.push(safe`? ${unknown} retention unknown`);
  return parts.join("   ");
}

/**
 * Entries `readMetadata` refused.
 *
 * The earlier fix covered an unreadable *file* and left an unreadable *entry*:
 * one bad `"pinned": "yes"` and that session's star and title vanished from
 * `list` with no word, while `doctor` reported it. The pin is still in the
 * file and still not in effect — which is exactly the state the user has to be
 * told about, where they would have seen the star.
 */
/**
 * Sessions `--at-risk` could not judge.
 *
 * An empty `--at-risk` list reads as "nothing is in danger", and with an
 * unreadable settings.json it meant "TermStash cannot work out the deadline
 * for any of them" — the opposite kind of answer, given in the same words.
 */
function reportUndeterminable(count: number): void {
  if (count === 0) return;
  err(
    safe`\n${count} session(s) could not be judged: TermStash cannot determine Claude's retention period.\n` +
      "  They are not included above. Run 'termstash doctor' for the reason.\n",
  );
}

/**
 * Archives this command could not see.
 *
 * `allSessions` computes both of these, and its own comment names the bug they
 * exist to prevent - `restore` answering "There are no archives yet" over an
 * intact transcript. Nothing read them, so `list` kept saying "No Claude Code
 * sessions found" with the user's only copies one chmod away.
 */
function reportArchiveTrouble(unreadableRoot: string | undefined, refused: readonly string[]): void {
  if (unreadableRoot !== undefined) {
    err(
      safe`\nTermStash's archive directory could not be read, so no archive is listed above:\n  ${unreadableRoot}\n`,
    );
  }
  if (refused.length > 0) {
    err(
      safe`\n${refused.length} archive(s) exist but could not be read, so the sessions they hold are not listed:\n` +
        safe`  ${refused[0] ?? ""}\n  Run 'termstash doctor --details' for all of them.\n`,
    );
  }
}

function reportRejected(overlay: Overlay): void {
  if (overlay.rejected === 0) return;
  err(
    safe`\n${overlay.rejected} metadata entr(ies) could not be read, so any pin or title on them is not shown:\n` +
      "  Run 'termstash doctor --details' for the ids.\n",
  );
}

function reportOverlayError(overlay: Overlay): void {
  if (overlay.error === undefined) return;
  err(
    "\nTermStash could not read its own metadata, so no pin or title is shown above:\n" +
      safe`  ${safeText(overlay.error)}\n` +
      "  Run 'termstash doctor' for the path.\n",
  );
}

function reportUnreadable(unreadable: readonly { path: string; reason: string }[]): void {
  if (unreadable.length === 0) return;
  err(safe`\n${unreadable.length} location(s) could not be read:\n`);
  for (const entry of unreadable.slice(0, 5)) {
    // A directory name is attacker-chosen in the same way a title is.
    err(safe`  ${safeText(entry.path)}: ${safeText(entry.reason)}\n`);
  }
}
