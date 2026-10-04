/**
 * Normalized domain model. PRD v0.2 section 9.1.
 *
 * These are facts read from an agent's storage. They are never written back.
 * TermStash's own state lives in SessionMetadata (PRD section 26), separately.
 */

export type RetentionStatus = "ok" | "at-risk" | "unknown";

export type SessionOrigin = "interactive" | "sdk-cli" | "unknown";

/** "termstash" is ours; the rest come from Claude's own transcript. */
export type TitleSource = "termstash" | "custom" | "ai" | "first-prompt";

export type Retention = {
  status: RetentionStatus;
  ageDays: number;
  /** Only present when status is "ok" or "at-risk". */
  estimatedDaysLeft?: number;
  /** Why the status is what it is. Always set for "unknown". */
  reason?: string;
};

export type Session = {
  id: string;
  agent: "claude-code";
  agentVersions: string[];
  sourcePath: string;
  projectDirName: string;
  projectPath?: string;
  projectName?: string;
  projectPathExists?: boolean;
  cwdHistory?: string[];
  gitBranch?: string;
  title?: string;
  titleSource?: TitleSource;
  createdAt?: Date;
  /** File mtime. Default sort key, and what Claude's retention sweep uses. */
  updatedAt: Date;
  /** Last timestamp inside the transcript. Diverges from updatedAt often. */
  lastMessageAt?: Date;
  sizeBytes: number;
  origin: SessionOrigin;
  isLive: boolean;
  /**
   * Claude no longer has this transcript; TermStash's archive is the only copy.
   *
   * Set only on sessions built from an archive. It changes what the user can
   * do - `restore` brings it back, `resume` cannot reach it until that happens
   * - so it is a fact worth carrying rather than inferring from a missing file.
   */
  archivedOnly?: boolean;
  hasSubagents: boolean;
  hasToolResults: boolean;
  retention: Retention;
  parseWarnings: string[];
  /** Record types this build has never seen. Fuel for doctor, not for logic. */
  unknownRecordTypes?: string[];
};

/**
 * A transcript Claude set aside rather than deleting. Never a live session.
 * PRD section 6.8 - behavior unverified, so these are reported, never acted on.
 */
export type TranscriptArtifact = {
  sessionId: string;
  kind: "orphaned" | "superseded";
  path: string;
  projectDirName: string;
  sizeBytes: number;
  mtime: Date;
};
