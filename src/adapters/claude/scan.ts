import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { TranscriptArtifact } from "../../core/session/types.js";
import { projectsDir } from "./paths.js";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/** A main session transcript, and nothing else. PRD v0.2 section 8. */
const MAIN_TRANSCRIPT = new RegExp(`^(${UUID})\\.jsonl$`);

/** Set-aside transcripts. Section 6.8. Reported by doctor, never listed. */
const ORPHANED = new RegExp(`^(${UUID})\\.orphaned-.+\\.jsonl$`);
const SUPERSEDED = new RegExp(`^(${UUID})\\.jsonl\\.superseded-.+$`);

export type ScannedTranscript = {
  id: string;
  sourcePath: string;
  projectDirName: string;
  sizeBytes: number;
  mtime: Date;
};

export type ScanResult = {
  transcripts: ScannedTranscript[];
  artifacts: TranscriptArtifact[];
  /** Project directories we could not read. Surfaced, never swallowed. */
  unreadable: { path: string; reason: string }[];
};

/**
 * Enumerate main session transcripts under <root>/projects.
 *
 * Deliberately shallow: subagent transcripts live at <uuid>/subagents/ and carry
 * the PARENT session's id, so recursing would corrupt the session list.
 */
export async function scanTranscripts(root: string): Promise<ScanResult> {
  const base = projectsDir(root);
  const result: ScanResult = { transcripts: [], artifacts: [], unreadable: [] };

  let projectDirs: string[];
  try {
    const entries = await readdir(base, { withFileTypes: true });
    projectDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (error) {
    // A missing projects directory is not a fault: it is what a machine looks
    // like before Claude Code has stored anything. Reporting it as a problem
    // would make a new user's first run read as a failure. A directory that
    // exists but cannot be read is a different matter.
    if (!isMissing(error)) result.unreadable.push({ path: base, reason: describe(error) });
    return result;
  }

  for (const projectDirName of projectDirs) {
    const dir = join(base, projectDirName);
    let names: string[];
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      names = entries.filter((e) => e.isFile()).map((e) => e.name);
    } catch (error) {
      // Removed between listing and reading: a race, not a fault.
      if (!isMissing(error)) result.unreadable.push({ path: dir, reason: describe(error) });
      continue;
    }

    for (const name of names) {
      const main = MAIN_TRANSCRIPT.exec(name);
      const sourcePath = join(dir, name);

      if (main?.[1]) {
        try {
          const st = await stat(sourcePath);
          result.transcripts.push({
            id: main[1],
            sourcePath,
            projectDirName,
            sizeBytes: st.size,
            mtime: st.mtime,
          });
        } catch (error) {
          if (!isMissing(error)) {
            result.unreadable.push({ path: sourcePath, reason: describe(error) });
          }
        }
        continue;
      }

      const artifact = ORPHANED.exec(name) ?? SUPERSEDED.exec(name);
      if (artifact?.[1]) {
        try {
          const st = await stat(sourcePath);
          result.artifacts.push({
            sessionId: artifact[1],
            kind: ORPHANED.test(name) ? "orphaned" : "superseded",
            path: sourcePath,
            projectDirName,
            sizeBytes: st.size,
            mtime: st.mtime,
          });
        } catch {
          // An artifact we cannot stat is not worth failing a scan over.
        }
      }
      // Everything else - sessions-index.json, MEMORY.md, .DS_Store, memory/ -
      // is not a session and is ignored without comment.
    }
  }

  return result;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}
