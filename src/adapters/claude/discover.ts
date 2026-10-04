import { stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { mapPool } from "../../core/async/pool.js";
import type { Session, TranscriptArtifact } from "../../core/session/types.js";
import { liveSessionIds } from "./liveness.js";
import { parseTranscript } from "./parse.js";
import { claudeRoot } from "./paths.js";
import { assessRetention, readRetentionPolicy } from "./retention.js";
import { scanTranscripts } from "./scan.js";
import type { ScannedTranscript } from "./scan.js";

/** Parsing is IO-bound; a small pool keeps a few hundred transcripts fast. */
const CONCURRENCY = 16;

export type Discovery = {
  sessions: Session[];
  artifacts: TranscriptArtifact[];
  unreadable: { path: string; reason: string }[];
};

export type DiscoverOptions = {
  root?: string;
  now?: Date;
};

/**
 * Read every Claude Code session on this machine. Read-only throughout: this
 * adapter never writes anything under Claude's config root.
 */
export async function discoverSessions(options: DiscoverOptions = {}): Promise<Discovery> {
  const root = options.root ?? claudeRoot();
  const now = options.now ?? new Date();

  const [scan, live, policy] = await Promise.all([
    scanTranscripts(root),
    liveSessionIds(root),
    readRetentionPolicy(root),
  ]);

  const sessions = await mapPool(scan.transcripts, CONCURRENCY, async (transcript) => {
    const parsed = await parseTranscript(transcript.sourcePath, transcript.sizeBytes);
    const sidecar = await inspectSidecar(transcript);
    const projectPathExists = parsed.cwd === undefined ? undefined : await exists(parsed.cwd);

    const warnings = [...parsed.warnings];
    if (
      parsed.internalSessionIds.length === 1 &&
      parsed.internalSessionIds[0] !== transcript.id
    ) {
      warnings.push("internal session id does not match the filename");
    }

    const session: Session = {
      id: transcript.id,
      agent: "claude-code",
      agentVersions: parsed.versions,
      sourcePath: transcript.sourcePath,
      projectDirName: transcript.projectDirName,
      ...(parsed.cwd !== undefined
        ? { projectPath: parsed.cwd, projectName: basename(parsed.cwd) }
        : {}),
      ...(projectPathExists !== undefined ? { projectPathExists } : {}),
      ...(parsed.cwdHistory.length > 0 ? { cwdHistory: parsed.cwdHistory } : {}),
      ...(parsed.gitBranch !== undefined ? { gitBranch: parsed.gitBranch } : {}),
      ...(parsed.title !== undefined ? { title: parsed.title } : {}),
      ...(parsed.titleSource !== undefined ? { titleSource: parsed.titleSource } : {}),
      ...(parsed.createdAt !== undefined ? { createdAt: parsed.createdAt } : {}),
      updatedAt: transcript.mtime,
      ...(parsed.lastMessageAt !== undefined ? { lastMessageAt: parsed.lastMessageAt } : {}),
      sizeBytes: transcript.sizeBytes,
      origin: parsed.origin,
      isLive: live.has(transcript.id),
      hasSubagents: sidecar.subagents,
      hasToolResults: sidecar.toolResults,
      retention: assessRetention(transcript.mtime, parsed.origin, policy, now),
      ...(parsed.unknownRecordTypes.length > 0
        ? { unknownRecordTypes: parsed.unknownRecordTypes }
        : {}),
      parseWarnings: warnings,
    };

    return session;
  });

  // Newest first. Section 11: mtime, because that is what Claude's sweep uses.
  sessions.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

  return { sessions, artifacts: scan.artifacts, unreadable: scan.unreadable };
}

async function inspectSidecar(transcript: ScannedTranscript) {
  const sidecar = join(dirname(transcript.sourcePath), transcript.id);
  const [subagents, toolResults] = await Promise.all([
    exists(join(sidecar, "subagents")),
    exists(join(sidecar, "tool-results")),
  ]);
  return { subagents, toolResults };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

