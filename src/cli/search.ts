import { discoverSessions } from "../adapters/claude/discover.js";
import type { Discovery } from "../adapters/claude/discover.js";
import { readHistory, searchHistory } from "../adapters/claude/history.js";
import type { HistoryMatch } from "../adapters/claude/history.js";
import { claudeRoot } from "../adapters/claude/paths.js";
import { searchTranscript } from "../adapters/claude/search.js";
import { extendsArchive, listArchives } from "../core/archive/store.js";
import type { StoredArchive } from "../core/archive/store.js";
import { classifyHistorical } from "../core/session/lost.js";
import { termstashRoot } from "../core/paths.js";
import { mapPool } from "../core/async/pool.js";
import type { MatchField, SessionMatch } from "../core/search/index.js";
import { contains, normalizeQuery, rankMatches, snippet } from "../core/search/index.js";
import type { Session } from "../core/session/types.js";
import { assignShortIds } from "../core/short-id/index.js";
import { allSessions, archiveSession } from "./sessions.js";
import type { ParsedArgs } from "./args.js";
import { flagBool, flagNumber } from "./args.js";
import { err, jsonOut, out, relativeTime, renderTable, safe, safeText, terminalWidth, truncate } from "./format.js";
import { readOverlay } from "./list.js";

const CONCURRENCY = 16;

export type SearchDeps = {
  discover?: () => Promise<Discovery>;
  claude?: string;
  root?: string;
  now?: Date;
};

export async function searchCommand(args: ParsedArgs, deps: SearchDeps = {}): Promise<number> {
  const now = deps.now ?? new Date();
  const query = args.positionals.join(" ");
  const needle = normalizeQuery(query);

  if (needle === "") {
    err("termstash search needs something to look for.\n  termstash search stripe\n");
    return 1;
  }

  const discover = deps.discover ?? (() => discoverSessions({ now }));
  // Archives are searched too. The footer named two sources and there were
  // three, and the third was the only place the text still existed - because
  // the user had pinned it, which is to say because they asked for exactly
  // this. "No matches" was the worst possible answer to give them.
  const root = deps.root ?? termstashRoot();
  const { sessions, unreadable: unreadableLocations, archives } = await allSessions({ root, discover });
  // A title the user set here is searchable like any other, and wins on display.
  const overlay = await readOverlay(sessions);
  // `list` reports this and `search` swallowed it, so a title the user set
  // here became unsearchable and `search` answered "No matches" about text it
  // was itself holding.
  if (overlay.error !== undefined) {
    err(
      safe`TermStash could not read its own metadata, so titles you set here were not searched:\n  ${overlay.error}\n`,
    );
  }
  const { matches, unreadable, skippedLines } = await findMatches(sessions, needle, overlay.titles);
  const ranked = rankMatches(matches);

  // The archive of a session Claude still has is searched too, when it holds
  // something the live transcript does not. The comment above used to claim
  // this and the code did the narrower thing: only an archive with no live
  // transcript beside it was ever opened. So a session compacted this morning
  // answered "No matches" about text sitting in the archive the user pinned it
  // for - the guard on one predicate, the read on another, one more time.
  const shadows = await shadowArchives(sessions, archives);
  const shadowFound = await findMatches(shadows.sessions, needle, overlay.titles);
  // A session that matched in both copies is one match, reported where the
  // user can act on it.
  const liveMatched = new Set(ranked.map((m) => m.session.id));
  const shadowRanked = rankMatches(
    shadowFound.matches.filter((m) => !liveMatched.has(m.session.id)),
  );

  const limit = flagNumber(args, "limit");
  const visible = limit === undefined ? ranked : ranked.slice(0, limit);
  const shadowRoom = limit === undefined ? undefined : Math.max(0, limit - visible.length);
  const visibleShadows = shadowRoom === undefined ? shadowRanked : shadowRanked.slice(0, shadowRoom);

  // Sessions Claude already swept and TermStash never archived. Their prompts
  // outlive their transcripts.
  const claude = deps.claude ?? claudeRoot();
  // Live means Claude still has the transcript. Once `sessions` included
  // archive-backed ones, every archived id counted as "resumable" here, so
  // `classifyHistorical` filtered them out of the history results and the
  // ARCHIVED - RESTORABLE group became unreachable code.
  const liveIds = new Set(
    sessions.filter((session) => session.archivedOnly !== true).map((s) => s.id),
  );
  const archivedIds = new Set((await listArchives(root)).map((a) => a.sessionId));
  // A session whose archive we just searched must not also be reported from
  // history: it is one match, and listing it twice reads as two.
  const searchedHere = new Set(ranked.map((m) => m.session.id));
  const allHistorical = [...(await searchHistory(claude, needle, snippet)).values()]
    .filter((m) => classifyHistorical(m.id, liveIds, archivedIds) !== "resumable")
    .filter((m) => !searchedHere.has(m.id))
    .sort((a, b) => b.lastSeen.getTime() - a.lastSeen.getTime());
  // `--limit` applies to the whole result, not to the table alone: limiting
  // the table and leaving the groups beneath it whole printed six rows under
  // `--limit 1`. And `total` counted only the sessions, so "N of M" managed to
  // be wrong in both directions at once - "Found 8 of 3 matches".
  const roomLeft =
    limit === undefined ? undefined : Math.max(0, limit - visible.length - visibleShadows.length);
  const historical = roomLeft === undefined ? allHistorical : allHistorical.slice(0, roomLeft);
  const totalMatches = ranked.length + shadowRanked.length + allHistorical.length;

  // The footer names the prompt history as a source whether or not it could be
  // read, which hides exactly the case `search` exists for: a session whose
  // only remaining evidence is there.
  const historyScan = await readHistory(claude);
  if (historyScan.unreadable !== undefined) {
    err(
      safe`Claude's prompt history could not be read, so sessions whose transcripts are gone were not searched:\n  ${historyScan.unreadable}\n`,
    );
  }

  const archivesSearched =
    sessions.filter((session) => session.archivedOnly === true).length + shadows.sessions.length;

  if (flagBool(args, "json")) {
    // The human footer says what was searched and what was skipped; --json
    // said neither, so a script could not tell "nothing matched" from "we
    // could not look". Same facts, same output.
    jsonOut({
      // Named "resumable" until archives joined the array, at which point the
      // key contradicted the per-entry flag inside it.
      sessions: toJson(visible, overlay.titles),
      // Separate key, not folded into `sessions`: these are not resumable as
      // they stand and a script that treated them as live results would act on
      // a transcript that no longer holds the text it matched.
      onlyInArchive: toJson(visibleShadows, overlay.titles).map((entry) => ({
        ...entry,
        state: "only-in-archive" as const,
      })),
      historical: toHistoryJson(historical, archivedIds),
      searched: {
        liveSessions: sessions.filter((session) => session.archivedOnly !== true).length,
        archives: archivesSearched,
        // Named only when actually consulted. An archive is searched when it is
        // the only copy left; an archive beside a live transcript is not, and
        // saying otherwise while reporting `archives: 0` was a contradiction
        // inside one object.
        sources: [
          "live transcripts",
          ...(archivesSearched > 0 ? ["TermStash archives"] : []),
          "Claude's prompt history",
        ],
        unreadableLocations: unreadableLocations.map((u) => u.path),
        unreadableTranscripts: unreadable + shadows.unreadable,
        skippedLines,
      },
    });
    return 0;
  }

  // One map over every id this command prints, live, archived and historical.
  // Three separate computations - `assignShortIds` over the matches, and two
  // hardcoded `slice(0, 6)` - put a 7-character id and a 6-character id for
  // different sessions in the same output, and the 6-character one was
  // ambiguous to every other command.
  const labels = assignShortIds([
    ...new Set([...sessions.map((x) => x.id), ...historical.map((m) => m.id)]),
  ]);

  render(
    visible,
    visibleShadows,
    totalMatches,
    {
      searched: sessions.filter((session) => session.archivedOnly !== true).length,
      unreadable: unreadable + shadows.unreadable,
      skippedLines,
      unreadableLocations: unreadableLocations.length,
      archives: archivesSearched,
    },
    historical,
    archivedIds,
    overlay.titles,
    labels,
    now,
  );
  return 0;
}

export type MatchResults = {
  matches: SessionMatch[];
  /** Transcripts that vanished or could not be read while searching. */
  unreadable: number;
  /** Lines no transcript reader would buffer. Reported, never swallowed. */
  skippedLines: number;
};

async function findMatches(
  sessions: readonly Session[],
  needle: string,
  ownTitles: ReadonlyMap<string, string>,
): Promise<MatchResults> {
  let unreadable = 0;
  let skippedLines = 0;

  const found = await mapPool(sessions, CONCURRENCY, async (session) => {
    const fields: MatchField[] = [];
    let best: { snippet: string; field: MatchField } | undefined;
    let hits = 0;

    const displayTitle = ownTitles.get(session.id) ?? session.title;
    if (contains(displayTitle, needle)) {
      fields.push("title");
      const text = displayTitle === undefined ? undefined : snippet(displayTitle, needle);
      if (text !== undefined) best = { snippet: text, field: "title" };
    }

    if (
      contains(session.projectName, needle) ||
      contains(session.projectPath, needle) ||
      contains(session.projectDirName, needle)
    ) {
      fields.push("project");
    }

    // Only open the file when the cheap fields did not already identify it.
    if (!fields.includes("title")) {
      try {
        const hit = await searchTranscript(session.sourcePath, needle);
        if (hit !== undefined) {
          if (hit.skippedLines !== undefined) skippedLines += hit.skippedLines;
          if (hit.hits > 0) fields.push(hit.field);
          hits = hit.hits;
          if (best === undefined && hit.snippet !== undefined) {
            best = { snippet: hit.snippet, field: hit.field };
          }
        }
      } catch {
        // Claude's sweep can delete a transcript between discovery and this
        // read. One missing file must not take the whole search down (section 5.2).
        unreadable += 1;
      }
    }

    if (fields.length === 0) return undefined;

    const match: SessionMatch = {
      session,
      fields: [...new Set(fields)],
      hits: Math.max(hits, 1),
      ...(best !== undefined ? { snippet: best.snippet, snippetField: best.field } : {}),
    };
    return match;
  });

  return {
    matches: found.filter((m): m is SessionMatch => m !== undefined),
    unreadable,
    skippedLines,
  };
}

/**
 * Archives that hold conversation the live transcript no longer does.
 *
 * `allSessions` adds an archive to the world only when Claude has no live
 * transcript for it, which is right for `list` and `resume` — there is nothing
 * else to show or to resume. It is wrong for `search`, because a compaction
 * leaves the live transcript shorter than the archive and the text the user is
 * looking for is then only in the copy they pinned it for. Measured: `search`
 * answered "No matches" with the phrase sitting in `archive/<id>/transcript.jsonl`.
 *
 * `extendsArchive` is the predicate, the same one the quarantine, the retire
 * and `pin`'s refusal consult. Only a definite "yes" — the live file begins
 * with exactly what the archive holds — means searching the live transcript
 * covered the archive as well. "shorter", "no" and "unreadable" all mean there
 * is something here to read.
 */
async function shadowArchives(
  sessions: readonly Session[],
  archives: ReadonlyMap<string, StoredArchive>,
): Promise<{ sessions: Session[]; unreadable: number }> {
  const found: Session[] = [];
  let unreadable = 0;

  for (const session of sessions) {
    if (session.archivedOnly === true) continue;
    const archive = archives.get(session.id);
    if (archive === undefined) continue;

    // The cheap check first, and it is the same one `list` uses: same length
    // and same timestamp is taken as the same bytes. Without it every search
    // hashed the first N bytes of every pinned transcript, which is the hook's
    // per-turn cost paid again on a read-only command. The state it misses —
    // same size, same mtime, different bytes — is the one the README already
    // names and sends to `doctor`.
    const recorded = new Date(archive.manifest.sourceMtime).getTime();
    if (
      session.sizeBytes === archive.manifest.transcriptSizeBytes &&
      !Number.isNaN(recorded) &&
      session.updatedAt.getTime() === recorded
    ) {
      continue;
    }

    if ((await extendsArchive(session.sourcePath, archive.manifest)) === "yes") continue;

    const shadow = await archiveSession(archive, false);
    // An archive we cannot open is not an archive we searched, and the footer
    // has to say so rather than let it pass as nothing to find.
    if (shadow === undefined) {
      unreadable += 1;
      continue;
    }
    found.push(shadow);
  }

  return { sessions: found, unreadable };
}

type Coverage = {
  searched: number;
  unreadable: number;
  skippedLines: number;
  /** Directories the scan could not open at all. */
  unreadableLocations: number;
  /** TermStash archives searched, which are not live sessions. */
  archives: number;
};

function render(
  matches: readonly SessionMatch[],
  onlyInArchive: readonly SessionMatch[],
  total: number,
  coverage: Coverage,
  historical: readonly HistoryMatch[],
  archivedIds: ReadonlySet<string>,
  titles: ReadonlyMap<string, string>,
  labels: ReadonlyMap<string, string>,
  now: Date,
): void {
  // A match in an archive is not resumable, and putting it in the same table
  // as live sessions said it was. It goes with the other restorable results.
  const resumable = matches.filter((m) => m.session.archivedOnly !== true);
  const restorable = matches.filter((m) => m.session.archivedOnly === true);

  if (matches.length === 0 && onlyInArchive.length === 0 && historical.length === 0) {
    out("\nNo matches.\n");
    // `footer` composes its own text, values already through `safe`, and it is
  // multi-line: re-sanitising it here would turn its newline into U+FFFD.
  out(`\n${footer(coverage)}\n`);
    return;
  }

  if (resumable.length === 0) {
    const elsewhere = restorable.length + onlyInArchive.length + historical.length;
    out(safe`\nFound ${elsewhere} match${elsewhere === 1 ? "" : "es"}, none of them in a live session\n`);
    renderArchived(restorable, labels, now);
    renderOnlyInArchive(onlyInArchive, labels, now);
    renderHistorical(historical, archivedIds, labels, now);
    // `footer` composes its own text, values already through `safe`, and it is
  // multi-line: re-sanitising it here would turn its newline into U+FFFD.
  out(`\n${footer(coverage)}\n`);
    return;
  }

  const rows = resumable.map((match) => [
    labels.get(match.session.id) ?? match.session.id,
    match.session.projectName ?? "—",
    relativeTime(match.session.updatedAt, now),
    titles.get(match.session.id) ?? match.session.title ?? "—",
  ]);

  const lines = renderTable(
    [
      { header: "ID", min: 6 },
      { header: "PROJECT", min: 8 },
      { header: "UPDATED", min: 9 },
      { header: "SESSION", flex: 1, min: 20 },
    ],
    rows,
    terminalWidth() - 2,
  );

  // Counted what the table held and ignored the groups printed under it, so
  // `--limit 1` announced one match above three.
  const displayed = matches.length + onlyInArchive.length + historical.length;
  const shown = displayed === total ? safe`${total}` : safe`${displayed} of ${total}`;
  out(safe`\nFound ${shown} match${total === 1 ? "" : "es"}\n\n`);
  out("RESUMABLE\n");

  const [header, ...bodyLines] = lines;
  out(safe`  ${header ?? ""}\n`);

  bodyLines.forEach((line, index) => {
    out(safe`  ${line}\n`);
    const match = resumable[index];
    // A title hit is already visible in the row; repeating it as a snippet
    // would be noise. Anything else needs evidence.
    if (match?.snippet !== undefined && match.snippetField !== "title") {
      const label = match.snippetField ?? "transcript";
      const count = match.hits > 1 ? safe` · ${match.hits} hits` : "";
      const width = Math.max(20, terminalWidth() - 14);
      out(safe`      ${label}${count} · ${truncate(match.snippet, width)}\n`);
    }
  });

  renderArchived(restorable, labels, now);
  renderOnlyInArchive(onlyInArchive, labels, now);
  renderHistorical(historical, archivedIds, labels, now);
  // `footer` composes its own text, values already through `safe`, and it is
  // multi-line: re-sanitising it here would turn its newline into U+FFFD.
  out(`\n${footer(coverage)}\n`);
}

/**
 * Matches that exist only in the archive, beside a live transcript that lost them.
 *
 * Its own group because the action is its own. These are not "archived —
 * restorable": Claude still has a transcript for this session, so `restore`
 * refuses without `--replace`, and suggesting a flag that displaces a live file
 * is not an answer to "where is my text". What the user needs is the path, and
 * the fact that the two copies disagree.
 */
function renderOnlyInArchive(
  matches: readonly SessionMatch[],
  labels: ReadonlyMap<string, string>,
  now: Date,
): void {
  if (matches.length === 0) return;
  out("\nONLY IN THE ARCHIVE — the live transcript no longer holds this\n");
  for (const match of matches) {
    const short = labels.get(match.session.id) ?? match.session.id;
    out(
      safe`  ${safeText(short)}  ${safeText(match.session.projectName ?? "—")}  ` +
        safe`archived ${relativeTime(match.session.updatedAt, now)}\n`,
    );
    if (match.snippet !== undefined) out(safe`      "${truncate(match.snippet, 72)}"\n`);
    out(safe`      ${safeText(match.session.sourcePath)}\n`);
    out(safe`      termstash doctor  explains why the two copies differ\n`);
  }
}

/**
 * Matches found inside TermStash's own archives.
 *
 * Separate from the live table because the action is different: these need a
 * restore before Claude can reach them. Separate from the history group
 * because the evidence is different - this is the transcript itself, not a
 * prompt Claude happened to remember.
 */
function renderArchived(
  matches: readonly SessionMatch[],
  labels: ReadonlyMap<string, string>,
  now: Date,
): void {
  if (matches.length === 0) return;
  out("\nARCHIVED — RESTORABLE\n");
  for (const match of matches) {
    const short = labels.get(match.session.id) ?? match.session.id;
    out(
      safe`  ${safeText(short)}  ${safeText(match.session.projectName ?? "—")}  ` +
        safe`last seen ${relativeTime(match.session.updatedAt, now)}\n`,
    );
    if (match.snippet !== undefined) out(safe`      "${truncate(match.snippet, 72)}"\n`);
    out(safe`      termstash restore ${safeText(short)}\n`);
  }
}

/**
 * Two groups, because the difference matters to the user: an archived session
 * is one `termstash restore` away, a lost one is gone for good (PRD section 14).
 */
function renderHistorical(
  historical: readonly HistoryMatch[],
  archivedIds: ReadonlySet<string>,
  labels: ReadonlyMap<string, string>,
  now: Date,
): void {
  if (historical.length === 0) return;

  const archived = historical.filter((m) => archivedIds.has(m.id));
  const lost = historical.filter((m) => !archivedIds.has(m.id));

  if (archived.length > 0) {
    out("\nARCHIVED — RESTORABLE\n");
    for (const match of archived) {
      out(
        safe`  ${safeText(labels.get(match.id) ?? match.id)}  ${safeText(basename(match.projectPath))}  last seen ${relativeTime(match.lastSeen, now)}\n`,
      );
      out(safe`      "${truncate(match.snippet, 72)}"\n`);
      out(safe`      termstash restore ${safeText(labels.get(match.id) ?? match.id)}\n`);
    }
  }

  if (lost.length > 0) {
    out("\nHISTORICAL — TRANSCRIPT GONE\n");
    for (const match of lost) {
      out(
        safe`  ${safeText(labels.get(match.id) ?? match.id)}  ${safeText(basename(match.projectPath))}  last seen ${relativeTime(match.lastSeen, now)}\n`,
      );
      out(safe`      "${truncate(match.snippet, 72)}"\n`);
      out("      not resumable\n");
    }
  }
}

function basename(path: string | undefined): string {
  if (path === undefined || path === "") return "—";
  const parts = path.split(/[/\\]/).filter((p) => p !== "");
  return parts[parts.length - 1] ?? path;
}

function toHistoryJson(matches: readonly HistoryMatch[], archivedIds: ReadonlySet<string>) {
  return matches.map((match) => ({
    id: match.id,
    projectPath: match.projectPath,
    lastSeen: match.lastSeen,
    hits: match.hits,
    snippet: match.snippet,
    state: archivedIds.has(match.id) ? "archived" : "lost",
    resumable: false,
  }));
}

/**
 * Never let silence read as proof. Saying what was searched is the difference
 * between "there is nothing" and "we did not look there" — and since swept
 * sessions are only reachable through history.jsonl, the footer names both
 * sources rather than leaving the reader to assume (PRD v0.2 section 14).
 */
function footer(coverage: Coverage): string {
  const { searched, unreadable, skippedLines, unreadableLocations, archives } = coverage;
  const unread =
    unreadable > 0 ? safe` ${unreadable} transcript(s) could not be read and were skipped.` : "";
  // A line too long to buffer is content this search did not look at, and the
  // reader has to be told - otherwise "No matches" means two different things
  // and looks like one.
  const tooLong =
    skippedLines > 0
      ? safe` ${skippedLines} line(s) were too long to read and were not searched.`
      : "";
  // A directory the scan could not open does not reduce the count of what was
  // searched - it was never in it. One chmod on projects/ made this read
  // "Searched 0 live sessions", which is true about this tool and false about
  // the user's data, and only the second reading was available to them.
  const blind =
    unreadableLocations > 0
      ? safe` ${unreadableLocations} location(s) could not be read at all, so sessions may be missing from this search.`
      : "";
  // `searched` counts live sessions only; subtracting archives as well made it
  // negative under a race ("Searched -28 live sessions").
  const count = Math.max(0, searched - unreadable);
  const here = archives > 0 ? safe`, ${archives} archive${archives === 1 ? "" : "s"}` : "";
  // `--help` and the README promise "prompts and transcripts", and this reads
  // human prompts and the assistant's own replies. Tool commands, tool results
  // and thinking blocks are deliberately out of scope (PRD section 29) - but
  // "No matches." is the same sentence whether the text is absent or merely
  // not looked at, so the limit is stated rather than assumed.
  return (
    safe`Searched ${count} live session${count === 1 ? "" : "s"}${here}` +
    " and Claude's prompt history." +
    unread +
    tooLong +
    blind +
    "\nPrompts and replies only — tool commands and their output are not searched."
  );
}

function toJson(matches: readonly SessionMatch[], titles: ReadonlyMap<string, string>) {
  return matches.map((match) => ({
    id: match.session.id,
    projectName: match.session.projectName,
    projectPath: match.session.projectPath,
    title: titles.get(match.session.id) ?? match.session.title,
    updatedAt: match.session.updatedAt,
    fields: match.fields,
    hits: match.hits,
    snippet: match.snippet,
    // Hardcoded true until archives were searched, at which point it became a
    // flat lie about half the array.
    resumable: match.session.archivedOnly !== true,
    ...(match.session.archivedOnly === true ? { state: "archived" as const } : {}),
  }));
}
