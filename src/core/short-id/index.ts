/**
 * Short ids are a TermStash affordance, not a Claude one: `claude --resume`
 * requires a full UUID and rejects prefixes. PRD v0.2 sections 6.5 and 34.
 */

export const MIN_SHORT_ID_LENGTH = 6;

/**
 * Assign the shortest unambiguous prefix to every id, widening past the
 * minimum only where ids actually collide. A short id that maps to two
 * sessions would make `list` unusable as a way to name one.
 */
export function assignShortIds(ids: readonly string[]): Map<string, string> {
  const assigned = new Map<string, string>();
  const unique = [...new Set(ids)];

  for (const id of unique) {
    let length = Math.min(MIN_SHORT_ID_LENGTH, id.length);
    while (length < id.length) {
      const candidate = id.slice(0, length);
      const collides = unique.some((other) => other !== id && other.startsWith(candidate));
      if (!collides) break;
      length += 1;
    }
    assigned.set(id, id.slice(0, length));
  }

  return assigned;
}

export type ShortIdResolution =
  | { status: "unique"; id: string }
  | { status: "none" }
  | { status: "ambiguous"; candidates: string[] };

/**
 * Expand a user-supplied handle to a full id.
 *
 * `claude --resume` rejects prefixes outright, so this expansion is the whole
 * reason short ids can exist. It must never guess: resuming the wrong session
 * is indistinguishable from losing the right one.
 *
 * Titles are deliberately not accepted here. Claude resolves them, but they
 * collide, and an ambiguous title makes Claude open an interactive picker
 * instead of doing what was asked (PRD v0.2 section 15).
 */
export function resolveShortId(ids: readonly string[], input: string): ShortIdResolution {
  const needle = input.trim().toLowerCase();
  if (needle === "") return { status: "none" };

  const exact = ids.find((id) => id.toLowerCase() === needle);
  if (exact !== undefined) return { status: "unique", id: exact };

  const matches = ids.filter((id) => id.toLowerCase().startsWith(needle));
  if (matches.length === 0) return { status: "none" };
  if (matches.length === 1 && matches[0] !== undefined) {
    return { status: "unique", id: matches[0] };
  }
  return { status: "ambiguous", candidates: matches };
}
