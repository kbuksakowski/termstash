import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileHistoryDir, projectsDir, sessionEnvDir } from "./paths.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type Orphan = {
  kind: "sidecar" | "session-env" | "file-history";
  sessionId: string;
  path: string;
};

/**
 * Per-session leftovers whose transcript is gone.
 *
 * Claude's retention sweep removes these alongside the transcript, so what
 * survives is real residue - the spike found two sidecar directories holding
 * subagent transcripts 79 days after their parent was swept.
 *
 * Reported only. TermStash does not delete anything on the user's behalf.
 */
export async function findOrphans(
  root: string,
  liveSessionIds: ReadonlySet<string>,
): Promise<Orphan[]> {
  const orphans: Orphan[] = [];

  for (const [kind, base] of [
    ["session-env", sessionEnvDir(root)],
    ["file-history", fileHistoryDir(root)],
  ] as const) {
    for (const name of await uuidDirs(base)) {
      if (!liveSessionIds.has(name)) {
        orphans.push({ kind, sessionId: name, path: join(base, name) });
      }
    }
  }

  // Sidecars live beside the transcript they belong to.
  let projects: string[];
  try {
    const entries = await readdir(projectsDir(root), { withFileTypes: true });
    projects = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return orphans;
  }

  for (const project of projects) {
    const dir = join(projectsDir(root), project);
    for (const name of await uuidDirs(dir)) {
      try {
        await stat(join(dir, `${name}.jsonl`));
      } catch {
        orphans.push({ kind: "sidecar", sessionId: name, path: join(dir, name) });
      }
    }
  }

  return orphans;
}

async function uuidDirs(base: string): Promise<string[]> {
  try {
    const entries = await readdir(base, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && UUID.test(e.name)).map((e) => e.name);
  } catch {
    return [];
  }
}
