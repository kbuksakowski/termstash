import { discoverSessions } from "../adapters/claude/discover.js";
import type { Discovery } from "../adapters/claude/discover.js";
import { readMetadata, updateSession } from "../core/metadata/store.js";
import { termstashRoot } from "../core/paths.js";
import { assignShortIds, resolveShortId } from "../core/short-id/index.js";
import { allSessions, duplicateSessionMessage, oneSession } from "./sessions.js";
import type { ParsedArgs } from "./args.js";
import { err, out, quoted, safe, safeText, truncate } from "./format.js";

export const MAX_TITLE_LENGTH = 120;

export type RenameDeps = {
  discover?: () => Promise<Discovery>;
  root?: string;
  now?: Date;
};

/**
 * Give a session a title of your own. PRD v0.2 section 5.4.
 *
 * Claude has `/rename`, but it needs you inside the session. Half the sessions
 * on a working machine are titled `/commit` or `/clear`, and the point of this
 * one is to fix that from the outside, while reading the list.
 *
 * The title lives in TermStash's metadata. Nothing is written to the transcript.
 */
export async function renameCommand(args: ParsedArgs, deps: RenameDeps = {}): Promise<number> {
  const now = deps.now ?? new Date();
  const root = deps.root ?? termstashRoot();
  const [handle, ...rest] = args.positionals;

  if (handle === undefined) {
    return fail(
      'termstash rename needs a session id and a title.\n  termstash rename 7f31a2 "Stripe webhook"\n' +
        "  termstash rename 7f31a2 --clear   removes a title you set",
    );
  }

  const clear = args.flags.has("clear");
  const title = rest.join(" ").trim();
  if (!clear && title === "") {
    return fail(
      'termstash rename needs a title.\n  termstash rename 7f31a2 "Stripe webhook"\n' +
        "  termstash rename 7f31a2 --clear   removes a title you set",
    );
  }
  if (title.length > MAX_TITLE_LENGTH) {
    return fail(safe`That title is ${title.length} characters; the limit is ${MAX_TITLE_LENGTH}.`);
  }

  const discover = deps.discover ?? (() => discoverSessions({ now }));
  // A title is TermStash's own state and needs no live transcript, so a swept
  // session can still be named — which is when a name is most useful.
  const { sessions } = await allSessions({ root, discover });
  const resolution = resolveShortId(sessions.map((s) => s.id), handle);

  if (resolution.status === "none") {
    return fail(safe`No session matches ${quoted(handle)}.\nRun 'termstash list' to see what is available.`);
  }
  if (resolution.status === "ambiguous") {
    return fail(safe`${quoted(handle)} matches ${resolution.candidates.length} sessions. Use a longer id.`);
  }

  const label = assignShortIds(sessions.map((s) => s.id)).get(resolution.id) ?? resolution.id;
  const picked = oneSession(sessions, resolution.id);
  if (!("session" in picked)) {
    if (picked.duplicates.length === 0) return fail(safe`No session matches ${quoted(handle)}.`);
    // A title is stored against the id, so with two sessions behind it this
    // renamed both - and said it had renamed one.
    return fail(duplicateSessionMessage(label, picked.duplicates));
  }
  const session = picked.session;

  if (clear) {
    const existing = (await readMetadata(root)).sessions[session.id]?.title;
    if (existing === undefined) {
      out(safe`${label} has no TermStash title. Nothing to do.\n`);
      return 0;
    }
    await updateSession(root, session.id, (current) => {
      const { title: _dropped, ...rest2 } = current;
      return rest2;
    });
    out(
      safe`✓ Title removed from ${label}\n  Back to Claude's own: ${describe(session.title)}\n`,
    );
    return 0;
  }

  // What this session is called right now, which is our title if it has one -
  // not Claude's. Reporting Claude's as "was" made a second rename look like it
  // had reverted something.
  const previous = (await readMetadata(root)).sessions[session.id]?.title ?? session.title;

  await updateSession(root, session.id, (current) => ({ ...current, title }));

  out(`✓ ${label} renamed\n`);
  if (previous !== undefined && previous !== title) {
    out(safe`  was: ${truncate(previous, 60)}\n  now: ${safeText(title)}\n`);
  }
  // Say the limitation rather than let it be discovered.
  out(
    "\n  This title is TermStash's own. Claude's session picker still shows its\n" +
      `  own title — use /rename inside the session to change that too.\n`,
  );
  return 0;
}

function describe(title: string | undefined): string {
  return title === undefined ? "(none)" : truncate(title, 60);
}

/**
 * The message arrives composed, and composing it is where `safe` belongs: the
 * caller knows which spans are its own layout and which are someone else's
 * text. Sanitising the finished message here would replace this tool's own
 * newlines with U+FFFD and fold a readable refusal into one unreadable line.
 */
function fail(message: string): number {
  err(`${message}\n`);
  return 1;
}
