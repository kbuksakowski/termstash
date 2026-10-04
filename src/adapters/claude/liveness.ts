import { readdir, readFile } from "node:fs/promises";
import { openRegularFile } from "../../core/fs/regular.js";
import { join } from "node:path";
import { liveSessionsDir } from "./paths.js";

/**
 * Sessions currently open in another Claude process. PRD v0.2 section 16.
 *
 * Claude writes one small file per running session and removes it on exit, so
 * this is read-only and cheap. Used to refuse concurrent resume and, later,
 * to refuse archiving or restoring a session that is being written to.
 */
export async function liveSessionIds(root: string): Promise<Set<string>> {
  const live = new Set<string>();
  let names: string[];

  try {
    names = await readdir(liveSessionsDir(root));
  } catch {
    // No directory means no running sessions. Not a problem worth reporting.
    return live;
  }

  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const handle = await openRegularFile(join(liveSessionsDir(root), name));
      if (handle === undefined) continue;
      let raw: string;
      try {
        raw = await handle.readFile("utf8");
      } finally {
        await handle.close();
      }
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null) continue;
      const { sessionId: id, pid } = parsed as { sessionId?: unknown; pid?: unknown };
      if (typeof id !== "string" || id === "") continue;
      // Claude removes the registry file on exit and clears crash leftovers on
      // its next launch, so between a crash and that launch a dead session
      // still has a file. Confirm the process before calling it live: this
      // marker later gates refusing resume, archive and restore.
      if (typeof pid === "number" && !isRunning(pid)) continue;
      live.add(id);
    } catch {
      // A half-written or stale registry file tells us nothing. Skip it.
    }
  }

  return live;
}

/** Signal 0 probes for existence without touching the process. */
function isRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to someone else - still running.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
