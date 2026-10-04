import type { ProtectionState } from "../metadata/store.js";
import type { ArchiveManifest } from "./manifest.js";

export type LiveTranscript = {
  sizeBytes: number;
  mtime: Date;
};

/**
 * What protection a session actually has right now. PRD v0.2 section 17.1.
 *
 * Always recomputed from the archive and the live transcript rather than read
 * from metadata: a cached "protected" that stopped being true is exactly the
 * claim section 17 forbids.
 *
 * "protected-stale" covers both an archive that fell behind and a pin with no
 * archive at all - section 12 marks both with the same hollow star, because in
 * both cases the session is not actually preserved as it stands.
 */
export function protectionState(input: {
  pinned: boolean;
  manifest?: ArchiveManifest;
  live?: LiveTranscript;
}): ProtectionState {
  if (!input.pinned) return "unprotected";
  if (input.manifest === undefined) return "protected-stale";
  if (input.live === undefined) {
    // The transcript is gone; the archive is all that is left, and it is intact.
    return "protected-current";
  }
  return isStale(input.manifest, input.live) ? "protected-stale" : "protected-current";
}

/**
 * Cheap comparison on size and mtime. SHA-256 is computed when an archive is
 * created or refreshed, not on every scan (section 17.1).
 */
export function isStale(manifest: ArchiveManifest, live: LiveTranscript): boolean {
  if (manifest.transcriptSizeBytes !== live.sizeBytes) return true;
  return new Date(manifest.sourceMtime).getTime() !== live.mtime.getTime();
}
