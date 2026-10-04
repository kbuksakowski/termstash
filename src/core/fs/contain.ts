import { realpath } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";

/**
 * The only way a write target is approved.
 *
 * `path.resolve` folds `..`; it does not follow links. A containment check
 * built on it passed a symlinked project directory straight through, and a
 * symlinked *ancestor* defeated it just as easily — the earlier version lstat'd
 * only the final component, so `projects` itself being a link was invisible.
 *
 * Resolution here is done with `realpath`, on both sides, against whatever part
 * of the path exists. A link anywhere along the way therefore moves the
 * candidate out of the root and the answer becomes no.
 *
 * This is still check-then-use, which no userland API on macOS fully escapes
 * without `openat`. What closes the remaining gap is the caller's half of the
 * contract: re-approve immediately before writing, and open the final component
 * with `O_NOFOLLOW` so a link swapped in at the last moment is refused rather
 * than followed.
 */
export async function containedPath(
  root: string,
  candidate: string,
): Promise<string | undefined> {
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    // A root that does not resolve cannot contain anything.
    return undefined;
  }

  const resolved = await resolveExisting(candidate);
  if (resolved === undefined) return undefined;

  if (resolved !== realRoot && !resolved.startsWith(`${realRoot}${sep}`)) return undefined;
  return resolved;
}

/**
 * Resolve a path whose leaf may not exist yet.
 *
 * Walks up to the deepest ancestor that does exist, resolves that, and rejoins
 * the missing tail. A restore target is usually a directory Claude has not
 * created yet, so refusing everything that does not already exist would refuse
 * the ordinary case.
 */
async function resolveExisting(candidate: string): Promise<string | undefined> {
  const missing: string[] = [];
  let current = resolve(candidate);

  for (;;) {
    try {
      const real = await realpath(current);
      return missing.length === 0 ? real : join(real, ...missing);
    } catch {
      const parent = dirname(current);
      if (parent === current) return undefined; // walked past the filesystem root
      missing.unshift(basename(current));
      current = parent;
    }
  }
}
