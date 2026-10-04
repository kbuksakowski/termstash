import { randomBytes } from "node:crypto";
import { safe } from "../text/safe.js";
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { containedPath } from "../fs/contain.js";
import { createExclusiveFile, openRegularFile } from "../fs/regular.js";
import { join } from "node:path";
import { DIR_MODE, FILE_MODE, archiveDir, archiveRoot, quarantineRoot } from "../paths.js";
import { checkJsonl, sha256File } from "./integrity.js";
import { isStale } from "./protection.js";
import type { ArchiveManifest } from "./manifest.js";
import { checkArchiveIdentity, checkManifest, parseManifest } from "./manifest.js";

export const TRANSCRIPT_NAME = "transcript.jsonl";
export const MANIFEST_NAME = "manifest.json";

export type StoredArchive = {
  sessionId: string;
  dir: string;
  transcriptPath: string;
  manifest: ArchiveManifest;
};

/**
 * Copy a transcript, refusing to follow a symlink at the final component.
 *
 * `scanTranscripts` rejects a dirent that is a link, but the copy opened the
 * path again by name, and a swap in between - a few milliseconds is enough -
 * made `archive` read a file outside both roots and store it as a faithful
 * copy of the session, checksums agreeing because both were taken after the
 * swap. O_NOFOLLOW closes the window rather than narrowing it, and fstat on
 * the handle we actually hold answers for the file we actually opened.
 */
async function copyRegularFile(from: string, to: string, limit?: number): Promise<boolean> {
  const source = await openRegularFile(from);
  if (source === undefined) return false;
  try {
    // The destination is created exclusively and follows no link either. The
    // first version of this guarded the source and wrote the target with a
    // plain writeFile, which follows a symlink at `to`.
    const target = await createExclusiveFile(to, FILE_MODE);
    if (target === undefined) return false;
    try {
      // `limit` is what makes this safe to run against a file that is being
      // written. Claude appends to the live transcript while the hook copies
      // it, so copying "the whole file" and then hashing "the whole file"
      // compared two different lengths: at 50 MB the refresh failed 8 times
      // out of 8, the hook threw the reason away, and the busiest pinned
      // sessions — the ones a pin is for — silently stopped being archived.
      //
      // The caller already has a byte count from its own `stat`. Copying
      // exactly that many bytes makes the copy a prefix snapshot, which is
      // precisely what an append-only file can promise.
      // `limit === 0` is an empty file, not `end: -1`.
      if (limit !== 0) {
        await pipeline(
          limit === undefined
            ? source.createReadStream()
            : source.createReadStream({ end: limit - 1 }),
          target.createWriteStream(),
        );
      }
    } finally {
      await target.close();
    }
    return true;
  } finally {
    await source.close();
  }
}

export async function readArchive(
  root: string,
  sessionId: string,
): Promise<StoredArchive | undefined> {
  // The id is joined onto a path before anything else happens, and it reaches
  // here from a directory listing, a CLI argument and a hook payload. One
  // refusal, at the point the id becomes a path, covers all three.
  if (checkArchiveIdentity(sessionId, undefined) !== undefined) return undefined;

  const dir = archiveDir(root, sessionId);
  const transcriptPath = join(dir, TRANSCRIPT_NAME);
  try {
    // The manifest is opened first, so it needs the rule first. The earlier
    // version of this guarded only the transcript, one filename later, and a
    // FIFO named manifest.json hung doctor, restore, search and the hook.
    const manifestHandle = await openRegularFile(join(dir, MANIFEST_NAME));
    if (manifestHandle === undefined) return undefined;
    let raw: string;
    try {
      raw = await manifestHandle.readFile("utf8");
    } finally {
      await manifestHandle.close();
    }

    const manifest = parseManifest(raw);
    if (manifest === undefined) return undefined;
    // `manifest.sessionId` is deliberately not consulted past this point, and
    // a disagreement with the directory name is deliberately not fatal. The
    // directory name is the one authority - every guard in `restoreArchive` is
    // computed from it - so a mismatched field decides nothing, and refusing
    // the archive over it would cost someone a transcript that is perfectly
    // intact to enforce a tidiness no behaviour depends on.

    const transcriptHandle = await openRegularFile(transcriptPath);
    if (transcriptHandle === undefined) return undefined;
    await transcriptHandle.close();

    return { sessionId, dir, transcriptPath, manifest };
  } catch {
    return undefined;
  }
}

/**
 * Whether the archive directory itself could be read.
 *
 * `[]` meant two different things - there are no archives, and we could not
 * look - and every caller read it as the first. One `chmod 000` on the archive
 * root made `list` say "No Claude Code sessions found", `restore` say "There
 * are no archives yet", and `doctor` report `0 archives`, with the user's only
 * copies sitting right there.
 */
export type ArchiveListing = { names: string[]; unreadable?: string };

async function archiveDirNames(root: string): Promise<ArchiveListing> {
  try {
    const entries = await readdir(archiveRoot(root), { withFileTypes: true });
    return {
      names: entries.filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name),
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Not yet created is the ordinary state of a fresh machine.
    if (code === "ENOENT") return { names: [] };
    return { names: [], unreadable: safe`${archiveRoot(root)}: ${code ?? String(error)}` };
  }
}

/** The reason the archive directory could not be listed, if it could not. */
export async function archiveRootError(root: string): Promise<string | undefined> {
  return (await archiveDirNames(root)).unreadable;
}

export async function listArchives(root: string): Promise<StoredArchive[]> {
  const archives: StoredArchive[] = [];
  for (const name of (await archiveDirNames(root)).names) {
    const archive = await readArchive(root, name);
    if (archive !== undefined) archives.push(archive);
  }
  return archives;
}

/**
 * Archive directories `listArchives` refuses to return.
 *
 * An archive TermStash refuses: a manifest that will not parse, or a
 * transcript that is not an ordinary file. Either one makes the archive
 * invisible to every command. Silently is the wrong way for that to
 * happen here: an archive the user believes protects a session, that nothing
 * will ever restore, is exactly the state this tool exists to make visible.
 */
export async function listUnreadableArchives(root: string): Promise<string[]> {
  const rejected: string[] = [];
  for (const name of (await archiveDirNames(root)).names) {
    if ((await readArchive(root, name)) === undefined) rejected.push(archiveDir(root, name));
  }
  return rejected;
}

/**
 * Working directories a crashed run left behind.
 *
 * Dot-prefixing these kept them out of the archive listing, which was the
 * point - but it also kept them out of the only command that reports anything
 * about the archive directory, so full 0600 transcript copies sat on disk
 * mentioned by nothing and pruned by nothing. The in-process cleanup does not
 * survive SIGKILL, so they are a fact of life and belong in the report.
 */
export async function listAbandonedWork(
  root: string,
  claudeProjects?: string,
): Promise<string[]> {
  const found: string[] = [];

  // Directories under the archive root.
  try {
    const entries = await readdir(archiveRoot(root), { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && /^\.(previous|staging)-/.test(entry.name)) {
        found.push(join(archiveRoot(root), entry.name));
      }
    }
  } catch {
    // Reported separately by archiveRootError.
  }

  // Staging *files*, which this only ever looked for as directories - so a
  // crash during `restore` left up to a full-size 0600 copy of a transcript
  // inside Claude's own projects directory, carrying the session's secrets,
  // mentioned by no command and pruned by nothing. `writeMetadata` and
  // `hook install` leave the same shape behind.
  found.push(...(await stagingFiles(root)));
  if (claudeProjects !== undefined) {
    for (const bucket of await subdirectories(claudeProjects)) {
      found.push(...(await stagingFiles(bucket)));
    }
  }
  return found;
}

/**
 * How long a working file is left alone before it is treated as abandoned.
 *
 * The staging file of a copy in flight has its mtime bumped continuously, so
 * anything untouched for an hour belongs to a process that is gone. A 200 MB
 * transcript copies in 2.2 s; an hour is three orders of magnitude of headroom
 * for a check whose only failure mode is deleting work another process is
 * still doing.
 */
const ABANDONED_AFTER_MS = 3_600_000;

/**
 * Delete working files a killed run left behind.
 *
 * `doctor` reported these as "safe to delete" and nothing ever deleted them,
 * including a later successful archive of the same session. The scenario that
 * produces them is the one in the first line of the README — closing the
 * terminal mid-turn, which kills the Stop hook in the middle of its copy — so
 * they arrive at the rate the user hits the case the product is for. Measured:
 * four interrupted runs against a 55 MB transcript left 218 MB behind, and a
 * successful archive afterwards took it to 272 MB without reclaiming any of it.
 *
 * `.previous-` directories are deliberately excluded. One of those holds an
 * archive that was kept *because* its replacement did not contain it — the
 * only copy of conversation the live transcript has lost. `doctor` tells those
 * apart by the same prefix and says "check before deleting"; deleting them
 * here would be this tool destroying the thing it exists to preserve.
 *
 * Never throws: this runs on the hook path, where the user is quitting.
 */
export async function pruneAbandonedWork(
  root: string,
  now: Date = new Date(),
): Promise<number> {
  let removed = 0;
  let paths: string[];
  try {
    paths = await listAbandonedWork(root);
  } catch {
    return 0;
  }

  for (const path of paths) {
    if (path.includes("/.previous-")) continue;
    try {
      if (now.getTime() - (await newestMtime(path)) < ABANDONED_AFTER_MS) continue;
      await rm(path, { recursive: true, force: true });
      removed += 1;
    } catch {
      // Another process got there first, or it is not ours to remove.
    }
  }
  return removed;
}

/** The directory's own mtime is not enough: copying into it does not touch it. */
async function newestMtime(path: string): Promise<number> {
  const info = await stat(path);
  if (!info.isDirectory()) return info.mtimeMs;
  let newest = info.mtimeMs;
  for (const entry of await readdir(path)) {
    try {
      newest = Math.max(newest, (await stat(join(path, entry))).mtimeMs);
    } catch {
      // Vanished under us; the rest of the directory still decides.
    }
  }
  return newest;
}

async function stagingFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && /\.termstash-[0-9a-f]{8}$/.test(e.name))
      .map((e) => join(dir, e.name));
  } catch {
    return [];
  }
}

async function subdirectories(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => join(dir, e.name));
  } catch {
    return [];
  }
}

export type ArchiveSource = {
  sessionId: string;
  sourcePath: string;
  sizeBytes: number;
  mtime: Date;
  projectPath?: string;
  projectDirName?: string;
  claudeVersions: string[];
};

export type RefreshOutcome =
  | { status: "up-to-date"; archive: StoredArchive }
  | { status: "rewritten"; archive: StoredArchive; reason: string }
  | { status: "refused"; archive: StoredArchive; reason: string }
  | { status: "failed"; reason: string };

/**
 * Is the live transcript still an extension of what the archive holds?
 *
 * Size alone cannot answer that, and size alone is what the first shrink guard
 * asked. `/compact` rewrites a transcript's history: the file gets shorter,
 * the guard refuses for a turn or two, and then the session grows past the old
 * byte count and the guard waves through a replacement that discards every
 * pre-compaction record. Same with a rewrite that happens to land on the same
 * length. The delay made it look safe; it only moved the loss.
 *
 * The archive already records the checksum of its own bytes, so comparing it
 * against the live file's first `transcriptSizeBytes` is a direct answer to
 * the real question. It costs one pass over the archived length, per refresh,
 * which is the price of not silently discarding someone's conversation.
 */
export type ArchiveRelation = "yes" | "shorter" | "no" | "unreadable";

export async function extendsArchive(
  livePath: string,
  manifest: ArchiveManifest,
): Promise<ArchiveRelation> {
  let size: number;
  try {
    size = (await stat(livePath)).size;
  } catch {
    return "unreadable";
  }
  // Asking for a prefix longer than the file gets a hash of the whole file,
  // which never matches - so a truncated transcript was diagnosed as
  // "no longer begins with what the archive holds" when it begins with
  // exactly that. Three commands then printed a reason that was not the
  // reason.
  if (size < manifest.transcriptSizeBytes) return "shorter";

  let prefix: string;
  try {
    prefix = await sha256File(livePath, manifest.transcriptSizeBytes);
  } catch {
    // Claude can delete a transcript at any moment and this runs after every
    // turn. "I could not read it" is a different answer from "it diverged",
    // and conflating them would blame the user's data for our own IO failure.
    return "unreadable";
  }
  return prefix === manifest.transcriptSha256 ? "yes" : "no";
}

/**
 * Bring a pinned session's archive back in line with its live transcript.
 *
 * This ran an incremental path for most of the project's life: Claude appends
 * to transcripts, so an archive that is a byte-exact prefix of the live file
 * could be brought up to date by copying only the tail. It was removed because
 * it was measured. On a 3.7 MB transcript that grew by 4 KB it took 29.7 ms
 * against 23.1 ms for a plain re-copy - slower, and O(file size) either way:
 * it copied the archive, appended, then took two whole-file SHA-256s, after
 * the prefix check had already hashed the live file once.
 *
 * It also wrote a second manifest, by a second route, which the validator
 * added for exactly that class of bug never saw. Two hundred lines and three
 * functions that cost more than they saved and carried their own surface.
 *
 * What is left is the cheap question and the honest answer. Staleness is size
 * and mtime, as it is everywhere else in this tool; the expensive byte
 * comparison belongs to doctor, which is the one command that does it.
 */
export async function refreshArchive(
  root: string,
  source: ArchiveSource,
  options: { now?: Date } = {},
): Promise<RefreshOutcome> {
  const existing = await readArchive(root, source.sessionId);
  if (existing === undefined) {
    const written = await writeArchive(root, source, options);
    if (written.status === "failed") return { status: "failed", reason: written.reason };
    return { status: "rewritten", archive: written.archive, reason: "no archive yet" };
  }

  if (!isStale(existing.manifest, { sizeBytes: source.sizeBytes, mtime: source.mtime })) {
    return { status: "up-to-date", archive: existing };
  }


  // An automatic refresh never shrinks an archive.
  //
  // This runs after every assistant turn. A transcript that got shorter has
  // been compacted, crashed mid-write, or restored from a backup - and in all
  // three the archive holds the conversation the live file no longer does,
  // which is the entire reason the session was pinned. Overwriting it here
  // destroyed eight records of pinned work in under a second, reported
  // nothing, and left `doctor` saying the archive was fine.
  //
  // Growing is the ordinary case and proceeds. Shrinking needs a person:
  // `termstash archive <id> --replace` is where that decision belongs.
  if (source.sizeBytes < existing.manifest.transcriptSizeBytes) {
    return {
      status: "refused",
      archive: existing,
      reason:
        `the live transcript is ${existing.manifest.transcriptSizeBytes - source.sizeBytes} byte(s) ` +
        "shorter than the archive, so refreshing would discard archived work",
    };
  }

  // Long enough is not the same as still the same. A compacted session grows
  // back past its old length within a few turns, and the size test then let
  // the replacement through with nothing said.
  const relation = await extendsArchive(source.sourcePath, existing.manifest);
  if (relation === "unreadable") {
    return { status: "failed", reason: "the live transcript could not be read" };
  }
  // "shorter" was added for the diagnosis and not handled here, so a transcript
  // that shrank between the caller's stat and this check fell through to the
  // refresh. The size test above only sees the size the caller measured.
  if (relation === "shorter") {
    return {
      status: "refused",
      archive: existing,
      reason: "the archive holds more than the live transcript, so refreshing would discard archived work",
    };
  }
  if (relation === "no") {
    return {
      status: "refused",
      archive: existing,
      reason:
        "the live transcript no longer begins with what the archive holds, so refreshing " +
        "would discard archived work",
    };
  }

  // Claude's sweep can take a transcript at any moment and this runs after
  // every assistant turn, so a failure here has to leave the existing archive
  // exactly as it was. writeArchive stages and verifies before it promotes,
  // and restores the previous directory if the promotion does not check out.
  const written = await writeArchive(root, source, { ...options, replace: true });
  if (written.status === "failed") return { status: "failed", reason: written.reason };
  return { status: "rewritten", archive: written.archive, reason: "the transcript changed" };
}

export type ArchiveOutcome =
  | {
      status: "created";
      archive: StoredArchive;
      uncheckedLines?: number;
      /** An unreadable archive that was set aside rather than destroyed. */
      discarded?: { why: "unreadable"; quarantinedTo: string };
    }
  | {
      status: "refreshed";
      archive: StoredArchive;
      previousMtime: string;
      uncheckedLines?: number;
      /** Set when the replacement did not contain the old archive, which was kept aside. */
      discarded?: { why: "shorter" | "rewritten"; quarantinedTo: string };
    }
  | { status: "already-current"; archive: StoredArchive }
  | { status: "stale-refused"; archive: StoredArchive }
  | { status: "failed"; reason: string };

/**
 * Copy a transcript into TermStash's archive and prove the copy is good.
 *
 * PRD v0.2 section 20. The manifest is written into the staging directory
 * before the whole directory is promoted, so there is never a moment where a
 * transcript exists without the manifest that describes it - a stricter
 * ordering than the section's numbered list, for the same reason it asks for
 * atomic finalisation.
 */
export async function writeArchive(
  root: string,
  source: ArchiveSource,
  options: { replace?: boolean; now?: Date } = {},
): Promise<ArchiveOutcome> {
  const now = options.now ?? new Date();

  // Asked before anything is copied, and asked again below once the manifest
  // is complete. Writing something this tool cannot read back is not a
  // smaller problem than reading something it should refuse — it is the same
  // problem, discovered later and by the user rather than by us.
  const identity = checkArchiveIdentity(source.sessionId, source.projectDirName);
  if (identity !== undefined) {
    return { status: "failed", reason: `${identity}; nothing was changed` };
  }

  // Before anything else, including the early returns. Placed just above the
  // staging copy it was reclaiming space for, it ran on none of the paths that
  // actually matter: `already-current` is the hook's answer on most turns, and
  // `stale-refused` is what `archive` returns before `refreshArchive` takes
  // over - so the leftovers were swept only by the one call that was going to
  // be large anyway. The guard on one path and the work on another.
  await pruneAbandonedWork(root, now);

  const existing = await readArchive(root, source.sessionId);

  if (existing !== undefined && options.replace !== true) {
    const stale =
      existing.manifest.transcriptSizeBytes !== source.sizeBytes ||
      new Date(existing.manifest.sourceMtime).getTime() !== source.mtime.getTime();
    return stale
      ? { status: "stale-refused", archive: existing }
      : { status: "already-current", archive: existing };
  }

  const staging = join(archiveRoot(root), `.staging-${source.sessionId}-${randomBytes(4).toString("hex")}`);
  const finalDir = archiveDir(root, source.sessionId);

  try {
    await mkdir(archiveRoot(root), { recursive: true, mode: DIR_MODE });
    await mkdir(staging, { recursive: true, mode: DIR_MODE });

    const stagedTranscript = join(staging, TRANSCRIPT_NAME);
    if (!(await copyRegularFile(source.sourcePath, stagedTranscript, source.sizeBytes))) {
      return {
        status: "failed",
        reason: "the transcript is not an ordinary file; nothing was changed",
      };
    }
    await chmod(stagedTranscript, FILE_MODE);
    // Fidelity only. Restore deliberately does not reuse this (section 21).
    await utimes(stagedTranscript, source.mtime, source.mtime);

    const [sourceHash, copyHash] = await Promise.all([
      sha256File(source.sourcePath, source.sizeBytes),
      sha256File(stagedTranscript),
    ]);
    if (sourceHash !== copyHash) {
      return { status: "failed", reason: "the copy did not match the source; nothing was changed" };
    }
    const jsonl = await checkJsonl(stagedTranscript);
    if (!jsonl.readable) {
      return { status: "failed", reason: "the copied transcript is not readable JSONL" };
    }

    const copied = await stat(stagedTranscript);
    const manifest: ArchiveManifest = {
      schemaVersion: 1,
      sessionId: source.sessionId,
      ...(source.projectPath !== undefined ? { projectPath: source.projectPath } : {}),
      ...(source.projectDirName !== undefined ? { projectDirName: source.projectDirName } : {}),
      claudeVersions: source.claudeVersions,
      sourcePath: source.sourcePath,
      archivedAt: existing?.manifest.archivedAt ?? now.toISOString(),
      sourceMtime: source.mtime.toISOString(),
      transcriptSha256: copyHash,
      transcriptSizeBytes: copied.size,
      ...(existing !== undefined
        ? { refreshedAt: now.toISOString(), refreshCount: (existing.manifest.refreshCount ?? 0) + 1 }
        : {}),
      includes: { subagents: false, toolResults: false, fileHistory: false },
    };
    // The same function `readArchive` uses, against the bytes about to be
    // written. The early check above covers what is knowable before the copy;
    // this one covers the rest, and will catch a field added to the reader
    // without being added to the writer, which is exactly how this started.
    const checked = checkManifest(manifest);
    if (!checked.ok) {
      return {
        status: "failed",
        reason: `the archive would not be readable back (${checked.reason}); nothing was changed`,
      };
    }

    const stagedManifest = join(staging, MANIFEST_NAME);
    await writeFile(stagedManifest, `${JSON.stringify(manifest, null, 2)}\n`, { mode: FILE_MODE });

    // An explicit --replace is allowed to overwrite; it is not allowed to
    // destroy. The shrink guard was put on `refreshArchive` and on `pin` and
    // not here, so the one door marked "I mean it" was also the one that threw
    // away 5 KB of archived conversation with "✓ Archive refreshed" and no
    // quarantine - while `pin` was pointing the user at this very command.
    //
    // The old transcript is set aside first, the same way `restore --replace`
    // sets aside a live one it is about to displace.
    //
    // The condition here was `sizeBytes <` while the guard that sends people to
    // this command asks whether the live file still extends the archive. In the
    // ordinary /compact case the live file is *longer*, so the quarantine never
    // fired and the retired copy was deleted - and `pin`'s own printed recovery
    // command, which promises "keeping the longer one in quarantine", destroyed
    // the archive it had just refused to overwrite. Same lesson as the guard
    // itself, applied to one of the two places that needed it.
    let discarded: { why: "shorter" | "rewritten"; quarantinedTo: string } | undefined;
    const relation =
      existing === undefined
        ? "yes"
        : await extendsArchive(source.sourcePath, existing.manifest);
    const contains = relation === "yes";
    if (existing !== undefined && !contains) {
      const kept = await quarantineTranscript(
        root,
        existing.transcriptPath,
        source.sessionId,
        now,
        "archive-overwritten",
      );
      discarded = {
        why: relation === "shorter" ? "shorter" : "rewritten",
        quarantinedTo: kept.dir,
      };
    }

    // Never destroy the only good archive before its replacement is in place.
    //
    // `existing` is the archive we could READ, and the directory can be there
    // without being readable: a zero-byte manifest, a missing transcript, a
    // symlinked transcript. The retire step was skipped in those cases, so the
    // promotion renamed onto a non-empty directory and threw ENOTEMPTY out of
    // the CLI - permanently. `archive`, `archive --replace` and `pin` all
    // failed with a raw errno, the hook failed in silence after every turn, and
    // `restore` reported there were no archives at all while an intact
    // transcript sat in that directory. Nothing could repair it.
    const occupied =
      existing !== undefined ||
      (await lstat(finalDir)
        .then(() => true)
        .catch(() => false));

    // A directory that is there but unreadable is the case we know least
    // about, and the self-repair above treated it as the case we were most
    // entitled to delete. Every shrink guard is gated on `readArchive`
    // succeeding, so when the manifest would not parse there was no guard at
    // all: `hook stop`, `pin`, and `archive` *without* `--replace` each
    // replaced an intact 8-record transcript with a 1-record one, reported
    // success, and left `list` saying ★ protected - the shrink this file
    // exists to prevent, brought back by the fix for the wedge.
    //
    // Repairing the wedge and preserving the bytes are not in conflict: set
    // the unreadable transcript aside first, then repair.
    let rescued: string | undefined;
    if (occupied && existing === undefined) {
      const orphanTranscript = join(finalDir, TRANSCRIPT_NAME);
      if (await openRegularFile(orphanTranscript).then(async (h) => {
        if (h === undefined) return false;
        await h.close();
        return true;
      })) {
        try {
          const kept = await quarantineTranscript(
          root,
          orphanTranscript,
          source.sessionId,
          now,
          "archive-unreadable",
        );
          rescued = kept.dir;
        } catch {
          // If it cannot be set aside, it must not be destroyed either.
          return {
            status: "failed",
            reason:
              `${finalDir} holds a transcript TermStash cannot read and cannot set aside. ` +
              "Move it somewhere safe yourself; nothing was changed.",
          };
        }
      }
    }

    let retired: string | undefined;
    if (occupied) {
      // Dot-prefixed and random, for two reasons: two processes in the same
      // millisecond collided on a timestamp and left the loser's directory
      // behind, and `archiveDirNames` skips only dotted names - so those
      // leftovers were counted as real archives sharing one session id, which
      // made `restore <short-id>` permanently ambiguous with no longer id able
      // to resolve it.
      retired = join(
        archiveRoot(root),
        `.previous-${source.sessionId}-${randomBytes(4).toString("hex")}`,
      );
      await rename(finalDir, retired);
    }

    try {
      await rename(staging, finalDir);
    } catch (error) {
      if (retired !== undefined) await rename(retired, finalDir);
      throw error;
    }

    const promoted = await readArchive(root, source.sessionId);
    if (promoted === undefined || (await sha256File(promoted.transcriptPath)) !== copyHash) {
      if (retired !== undefined) {
        await rm(finalDir, { recursive: true, force: true });
        await rename(retired, finalDir);
      }
      return { status: "failed", reason: "the promoted archive did not verify; the previous state was kept" };
    }

    // Deleted only when we could read what we are deleting and the new copy
    // is at least as long. Anything else - an unreadable archive, a directory
    // the user put their own files in - is kept where `doctor` will name it.
    if (retired !== undefined) {
      // Deleted only when the new copy actually contains the old one. Longer is
      // not the same as containing: a rewritten history is longer and holds
      // none of it.
      // `contains` was computed from the size `stat` reported, which can be
      // stale; `copied.size` is what actually landed in the archive.
      const reallyContains =
        contains &&
        existing !== undefined &&
        copied.size >= existing.manifest.transcriptSizeBytes;
      if (reallyContains) await rm(retired, { recursive: true, force: true });
    }

    // Reported rather than swallowed: a record too large to parse is a record
    // this archive contains and did not verify, and the user is the one who
    // gets to decide whether that matters.
    const unchecked = jsonl.unchecked > 0 ? { uncheckedLines: jsonl.unchecked } : {};
    return existing === undefined
      ? {
          status: "created",
          archive: promoted,
          ...unchecked,
          ...(rescued !== undefined
            ? { discarded: { why: "unreadable" as const, quarantinedTo: rescued } }
            : {}),
        }
      : {
          status: "refreshed",
          archive: promoted,
          previousMtime: existing.manifest.sourceMtime,
          ...unchecked,
          ...(discarded !== undefined ? { discarded } : {}),
        };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export type QuarantineRecord = {
  schemaVersion: 1;
  sessionId: string;
  originalPath: string;
  quarantinedAt: string;
  reason: "replaced-by-restore" | "archive-overwritten" | "archive-unreadable";
  sha256: string;
  sizeBytes: number;
  mtime: string;
};

/**
 * Set a displaced transcript aside. PRD section 21 Step 2a.
 *
 * The copy is verified before the original is removed, so the file never exists
 * in only one unverified place. TermStash never prunes this directory.
 */
export async function quarantineTranscript(
  root: string,
  sourcePath: string,
  sessionId: string,
  now: Date = new Date(),
  // Three callers, one hardcoded reason: `origin.json` claimed every file here
  // was displaced by a restore, including the ones an `archive` set aside.
  reason: QuarantineRecord["reason"] = "replaced-by-restore",
): Promise<{ dir: string; record: QuarantineRecord }> {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const dir = join(quarantineRoot(root), sessionId, stamp);

  // The whole line of reasoning applied to the restore target was never applied
  // here - to the directory that holds the user's only copy of displaced live
  // work. A symlink at quarantine/<id> sent it outside TERMSTASH_HOME while the
  // message reported the lexical path, so it looked fine.
  //
  // The root has to exist before it can anchor a containment check; the
  // session and timestamp directories below it do not.
  await mkdir(quarantineRoot(root), { recursive: true, mode: DIR_MODE });
  // Approved before the rest of the mkdir, not after: creating it first meant
  // a refused path still left an empty directory outside the root.
  if ((await containedPath(quarantineRoot(root), dir)) === undefined) {
    throw new Error(
      `${dir} resolves outside ${quarantineRoot(root)}. The transcript was not displaced.`,
    );
  }
  await mkdir(dir, { recursive: true, mode: DIR_MODE });
  // Re-approved after the mkdir and before anything is written, the same
  // contract `restoreArchive` follows.
  if ((await containedPath(quarantineRoot(root), dir)) === undefined) {
    throw new Error(
      `${dir} resolves outside ${quarantineRoot(root)}. The transcript was not displaced.`,
    );
  }

  const target = join(dir, TRANSCRIPT_NAME);
  const info = await stat(sourcePath);
  if (!(await copyRegularFile(sourcePath, target))) {
    throw new Error(`${sourcePath} is not an ordinary file; it was not displaced.`);
  }
  await chmod(target, FILE_MODE);
  await utimes(target, info.mtime, info.mtime);

  const [sourceHash, copyHash] = await Promise.all([sha256File(sourcePath), sha256File(target)]);
  if (sourceHash !== copyHash) {
    throw new Error("quarantine copy did not match the original; nothing was removed");
  }

  const record: QuarantineRecord = {
    schemaVersion: 1,
    sessionId,
    originalPath: sourcePath,
    quarantinedAt: now.toISOString(),
    reason,
    sha256: copyHash,
    sizeBytes: info.size,
    mtime: info.mtime.toISOString(),
  };
  await writeFile(join(dir, "origin.json"), `${JSON.stringify(record, null, 2)}\n`, {
    mode: FILE_MODE,
  });

  return { dir, record };
}

export type QuarantinedItem = {
  sessionId: string;
  dir: string;
  record?: QuarantineRecord;
};

/** Read-only. TermStash never prunes the quarantine (PRD v0.2 section 21). */
export async function listQuarantine(root: string): Promise<QuarantinedItem[]> {
  const items: QuarantinedItem[] = [];
  let sessions: string[];
  try {
    const entries = await readdir(quarantineRoot(root), { withFileTypes: true });
    sessions = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return items;
  }

  for (const sessionId of sessions) {
    let stamps: string[];
    try {
      const entries = await readdir(join(quarantineRoot(root), sessionId), { withFileTypes: true });
      stamps = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      continue;
    }
    for (const stamp of stamps) {
      const dir = join(quarantineRoot(root), sessionId, stamp);
      let record: QuarantineRecord | undefined;
      try {
        // The last read below the CLI that opened by name. A FIFO at
        // origin.json hung `doctor`, and a symlink to /dev/zero took 643 MB
        // before the RangeError was swallowed.
        const originHandle = await openRegularFile(join(dir, "origin.json"));
        if (originHandle === undefined) continue;
        let originRaw: string;
        try {
          originRaw = await originHandle.readFile("utf8");
        } finally {
          await originHandle.close();
        }
        record = JSON.parse(originRaw) as QuarantineRecord;
      } catch {
        record = undefined;
      }
      items.push({ sessionId, dir, ...(record !== undefined ? { record } : {}) });
    }
  }
  return items;
}
