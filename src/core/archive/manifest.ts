/**
 * What an archive records about itself, in `manifest.json` beside the copy.
 *
 * Enough to answer three questions without trusting anything else: which
 * session this is and where it belonged (`sessionId`, `projectDirName`), what
 * the copy should contain (`transcriptSha256`, `transcriptSizeBytes`), and how
 * it relates to the live file it came from (`sourceMtime`). Every check that
 * decides whether an archive may be read, refreshed or restored is computed
 * from these fields. PRD v0.2 section 19.
 */
export type ArchiveManifest = {
  schemaVersion: 1;
  sessionId: string;
  projectPath?: string;
  projectDirName?: string;
  claudeVersions: string[];
  sourcePath: string;
  archivedAt: string;
  /** The live transcript's mtime when it was archived. A fact, not a target. */
  sourceMtime: string;
  transcriptSha256: string;
  transcriptSizeBytes: number;
  refreshedAt?: string;
  refreshCount?: number;
  includes?: {
    subagents: boolean;
    toolResults: boolean;
    fileHistory: boolean;
  };
};

/**
 * A project directory name must be one path segment and nothing else.
 *
 * `projectDirName` is read back out of a manifest and joined onto Claude's
 * projects directory to decide where a restore lands. An archive is a plain
 * directory that can be copied between machines, so its manifest is input, not
 * a fact — one carrying `../../..` would place the restored transcript
 * anywhere the user can write. Claude builds these names by replacing every
 * non-alphanumeric character with a dash, so a legitimate one never contains a
 * separator.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isSafeSegment(value: string): boolean {
  if (value === "" || value === "." || value === "..") return false;
  return !/[/\\\0]/.test(value);
}

export type ManifestCheck =
  | { ok: true; manifest: ArchiveManifest }
  | { ok: false; reason: string };

/**
 * The one place a manifest is judged, used in both directions.
 *
 * It was enforced on read only. `parseManifest` refused an unsafe
 * `projectDirName` and `writeArchive` stored one without blinking, so a hook
 * whose `transcript_path` had `..` as its second-to-last component wrote an
 * archive this tool would then never read back: the pinned session stayed
 * unprotected, and the hook rewrote the same unreadable archive after every
 * assistant turn. The check standing on one side of the boundary while the
 * write stood on the other is the shape that produced a third of the findings
 * in this round; this function exists so there is only one side.
 *
 * Returns a reason rather than a boolean. Writing refuses out loud — a refusal
 * nobody is told about is how a tool that promises preservation quietly stops
 * preserving.
 */
export function checkManifest(value: unknown): ManifestCheck {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, reason: "the manifest is not an object" };
  }

  const m = value as Partial<ArchiveManifest>;
  if (m.schemaVersion !== 1) return { ok: false, reason: "schemaVersion is not 1" };
  if (typeof m.sessionId !== "string") return { ok: false, reason: "sessionId is not a string" };
  if (typeof m.transcriptSha256 !== "string") {
    return { ok: false, reason: "transcriptSha256 is not a string" };
  }
  if (typeof m.sourceMtime !== "string") return { ok: false, reason: "sourceMtime is not a string" };
  if (typeof m.transcriptSizeBytes !== "number") {
    return { ok: false, reason: "transcriptSizeBytes is not a number" };
  }
  if (m.projectDirName !== undefined && typeof m.projectDirName !== "string") {
    return { ok: false, reason: "projectDirName is not a string" };
  }

  const identity = checkArchiveIdentity(m.sessionId, m.projectDirName);
  if (identity !== undefined) return { ok: false, reason: identity };

  return { ok: true, manifest: m as ArchiveManifest };
}

/**
 * The two fields that decide where a file lands, checkable before one exists.
 *
 * `writeArchive` cannot build a whole manifest until it has copied and hashed
 * the transcript, and refusing after a copy is a worse answer than refusing
 * before one. So the half of `checkManifest` that does not need the copy is
 * callable on its own, and `checkManifest` calls it too: one implementation,
 * asked early on write, again before the bytes hit the disk, and once more on
 * every read.
 *
 * Returns the reason it is unusable, or `undefined` when it is fine.
 */
export function checkArchiveIdentity(
  sessionId: string,
  projectDirName: string | undefined,
): string | undefined {
  // Claude session ids are UUIDs without exception, and this one names a file
  // on restore. `projectDirName` was validated first and `sessionId` was not,
  // which left the same hole one field over: a manifest could still pick the
  // filename, and `../..` in it escaped the directory the caller checked.
  if (!UUID.test(sessionId)) {
    return `"${sessionId}" is not a session id`;
  }
  if (projectDirName !== undefined && !isSafeSegment(projectDirName)) {
    return `"${projectDirName}" is not a usable project directory name`;
  }
  return undefined;
}

export function parseManifest(raw: string): ArchiveManifest | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const checked = checkManifest(value);
  return checked.ok ? checked.manifest : undefined;
}
