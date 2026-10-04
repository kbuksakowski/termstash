# TECHNICAL SPIKE — Claude Code Session Storage

> Status: complete
> Date: 2026-09-08, with corrections dated 2026-09-12 and 2026-09-13 marked in place
> Scope: read-only investigation + controlled experiments on throwaway sessions
> Purpose: establish how Claude Code actually stores sessions, before writing any TermStash code
> **No product code was written. No pre-existing session file was modified, moved or deleted.**
>
> References of the form `PRD v0.2 §N` point at an internal design document that is not
> published. Each one is a breadcrumb, not the explanation — the reasoning it cites is stated
> here, and what was actually built is the code and `CHANGELOG.md`.

---

## 0. Environment under test

| Item                | Value                                                                                  |
| ------------------- | -------------------------------------------------------------------------------------- |
| Claude Code         | `2.1.263` (native install, commit `37ae3f38d765`)                                      |
| Platform            | `darwin-arm64` (macOS 24.6.0)                                                          |
| Node                | `v20.20.2`                                                                             |
| Binary              | `/Users/you/.local/bin/claude` → `~/.local/share/claude/versions/2.1.263`            |
| Config dir          | `~/.claude` (`CLAUDE_CONFIG_DIR` unset)                                                |
| Corpus              | 40 project dirs · 209 main transcripts (399.4 MB) · 203 subagent transcripts (78.8 MB) |
| `cleanupPeriodDays` | not set anywhere → default (30)                                                        |

### What was touched

| Action                   | Target                                                                         |
| ------------------------ | ------------------------------------------------------------------------------ |
| Read only                | every pre-existing file under `~/.claude`                                      |
| Created                  | 3 throwaway sessions in throwaway cwds (see §10.2)                             |
| Moved / copied / removed | **only** the throwaway spike transcripts, inside the experiment                |
| Never changed            | `cleanupPeriodDays`, any mtime of user data, `settings.json`, `~/.claude.json` |

---

## 1. Observed filesystem structure

```
~/.claude/                                  (== %USERPROFILE%\.claude on Windows;
│                                            relocatable via CLAUDE_CONFIG_DIR)
├── projects/
│   └── <encoded-project-dir>/              e.g. -Users-you-work-web-client
│       ├── <session-uuid>.jsonl            ◀── THE SESSION. Source of truth.
│       ├── <session-uuid>/                 ◀── optional sidecar dir, same basename
│       │   ├── subagents/
│       │   │   └── agent-<hash>.jsonl      subagent (sidechain) transcripts
│       │   └── tool-results/
│       │       └── toolu_<id>.txt          large tool outputs spilled to disk
│       ├── memory/                         auto-memory (NOT session data)
│       ├── sessions-index.json             ◀── LEGACY. Stale. See §3.2
│       └── .DS_Store / MEMORY.md           junk / user files — must be ignored
│
├── history.jsonl                           every prompt ever typed. NEVER swept. §3.4
├── .claude.json                            global config incl. projects{} map. §3.5
├── .last-cleanup                           ISO timestamp of last retention sweep
├── sessions/
│   ├── <pid>.json                          LIVE session registry (running only). §3.3
│   └── <pid>.<sha256>.key                  peer token for that live session
├── session-env/<session-uuid>/             per-session env metadata (199 dirs here)
├── file-history/<session-uuid>/            pre-edit snapshots for /rewind
├── paste-cache/, image-cache/<session>/    attachment/paste bodies
├── plans/, debug/, shell-snapshots/        per-session ephemera
└── backups/, cache/, telemetry/, usage-data/, jobs/, daemon/
```

### 1.1 Project directory name encoding — lossy, do not invert

Officially: _"the working directory path with non-alphanumeric characters replaced by `-`"_.

Verified experimentally (E11): cwd `…/scratchpad/spike.c d-ü` → dir `…-scratchpad-spike-c-d--`

```
rule:      path.replace(/[^a-zA-Z0-9]/g, '-')
'/' → '-'   '_' → '-'   '.' → '-'   ' ' → '-'   '-' → '-'   'ü' → '-'
```

All three candidate rules (`[/_]`, `[/_.]`, `[^a-zA-Z0-9]`) agreed on every real directory on
this machine, because no real path here contains a dot or a space. Only the synthetic test
discriminated them.

Additional traps:

| Trap                                                                             | Consequence                                       |
| -------------------------------------------------------------------------------- | ------------------------------------------------- |
| Collision: `/a/b_c` and `/a/b/c` and `/a/b-c` → same dir                         | one dir may hold sessions from several real paths |
| Name > 200 chars → truncated + hash of full path appended                        | pure string inversion breaks entirely             |
| `CLAUDE_CODE_PROJECT_DIR_NAME` (v2.1.234+) overrides the derived name completely | dir name may bear no relation to any path         |

**→ Never decode the directory name. Read `cwd` from inside the transcript.**
Directory name is a bucket, not data. (Sanity cross-check available: the keys of
`~/.claude.json.projects` are 73 real absolute paths; `history.jsonl.project` is another.)

---

## 2. Observed transcript schema (`<session-uuid>.jsonl`)

One JSON object per line, append-only. `session_id` (snake) appears on some records as a
duplicate of `sessionId`; ignore it.

### 2.1 Record types seen (sample of 40 files, 18k records)

| `type`                                                                                                                 |   count | carries                                                                      | use for                           |
| ---------------------------------------------------------------------------------------------------------------------- | ------: | ---------------------------------------------------------------------------- | --------------------------------- |
| `assistant`                                                                                                            |    6265 | `message.{id,role,model,content[],usage,stop_reason}`, `requestId`, `effort` | responses, model, cost            |
| `user`                                                                                                                 |    3731 | `message.{role,content}`, `promptId`, `toolUseResult?`, `isMeta?`            | prompts (filter! see 2.3)         |
| `attachment`                                                                                                           |    3255 | `attachment`                                                                 | ignore                            |
| `mode` / `permission-mode`                                                                                             | 880/831 | `mode`, `permissionMode`                                                     | session state                     |
| `last-prompt`                                                                                                          |     880 | `leafUuid`                                                                   | conversation leaf pointer         |
| **`ai-title`**                                                                                                         |     769 | `aiTitle`                                                                    | **generated title**               |
| **`custom-title`**                                                                                                     |      49 | `customTitle`                                                                | **user title (`-n` / `/rename`)** |
| `agent-name`                                                                                                           |      49 | `agentName`                                                                  | mirrors custom-title              |
| `system`                                                                                                               |     630 | `subtype:"turn_duration"`, `durationMs`, `messageCount`                      | telemetry                         |
| `bridge-session`                                                                                                       |     524 | `bridgeSessionId`, `ownerAccountUuid`                                        | cloud/Remote Control link         |
| `file-history-snapshot`                                                                                                |     410 | `snapshot.trackedFileBackups`                                                | **huge; blocks head-sampling**    |
| `queue-operation`, `atis-latch`, `cost-state`, `frame-link`, `file-history-delta`, `artifact-*`, `history-suppression` |       — | —                                                                            | ignore                            |
| `summary` (legacy)                                                                                                     |   **0** | `summary`, `leafUuid`                                                        | older CC only — still handle      |

### 2.2 Field-level findings

| PRD field         | Where it actually lives                                                                             | Reliability                                                                                |
| ----------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `id`              | filename basename; also `.sessionId` on nearly every record                                         | **209/209 files: filename == internal `sessionId`, single value per file.** Safe.          |
| `projectPath`     | `.cwd` on the **first** `user`/`assistant`/`system` record                                          | 205/209. Note: `cwd` is **per record** — one session can span several cwds (see E3, `/cd`) |
| `createdAt`       | first record with `.timestamp` (ISO-8601 UTC)                                                       | 205/209                                                                                    |
| `updatedAt`       | **file mtime**                                                                                      | 100%. See 2.4                                                                              |
| `title`           | last `custom-title` → else last `ai-title` → else first user prompt                                 | 22 custom / 81 ai / **105 neither** in 208 sessions                                        |
| `gitBranch`       | `.gitBranch` per record (`"HEAD"` when detached / non-repo)                                         | present                                                                                    |
| `agent` version   | `.version` per record — a file can contain several (resume across upgrades)                         | present                                                                                    |
| `sessionPath`     | the `.jsonl` absolute path                                                                          | —                                                                                          |
| sidechain         | `.isSidechain: true` + file at `<uuid>/subagents/agent-*.jsonl` carrying the **parent** `sessionId` | reliable                                                                                   |
| `-p` / SDK origin | `.entrypoint: "sdk-cli"` (vs `"cli"` interactive)                                                   | reliable                                                                                   |

### 2.3 Prompt extraction is not `message.content`

`user` records must be filtered or `search` and `firstPrompt` will be garbage:

```
skip if  .isMeta === true                  → injected system noise
skip if  .toolUseResult != null            → tool result, not a human turn
skip if  .isSidechain === true             → subagent turn
.message.content is string OR array of blocks → handle both
strings may be wrapped:  <command-message>…</command-message>
                         <command-name>/commit</command-name>
                         <local-command-stdout>…</local-command-stdout>
                         [Pasted text #1 +34 lines]
```

### 2.4 `updatedAt`: mtime vs last message timestamp

91 of 207 sessions have `mtime − lastTimestampedRecord > 120 s`, some by **5 days**.
Cause: `ai-title`, `mode`, `last-prompt`, `bridge-session`, `cost-state` are written
**without** a `timestamp`, and get appended on resume/exit/title-refresh.

```
updatedAt      := file mtime        ← matches cleanup semantics + Claude's own picker
lastMessageAt  := last .timestamp   ← show this to the user as "last message"
```

⚠ Any copy without `-p` / `preserveTimestamps` rewrites mtime → resets the 30-day cleanup
clock **and** corrupts sort order. Always preserve mtimes.

### 2.5 Head-sampling caveat

Reading the first 256 KB is **not** enough to find `cwd`/`createdAt`. 2 of 209 sessions
(20 MB and 1.7 MB) begin with a run of `file-history-snapshot` records that fill the whole
window. 2 more are degenerate 267-byte files containing a single `bridge-session` record.

**→ stream lines from the start until the first record with `.cwd`, capped (e.g. 2000 lines
or 8 MB), and treat "not found" as a `doctor` finding, not a crash.**

---

## 3. Observed schemas — the other stores

### 3.1 Summary

| Store                            | Written by 2.1.263? | Needed for resume?         | Useful to us                             |
| -------------------------------- | ------------------- | -------------------------- | ---------------------------------------- |
| `projects/**/<uuid>.jsonl`       | **yes**             | **yes — sole requirement** | everything                               |
| `projects/*/sessions-index.json` | **no (legacy)**     | **no**                     | nothing — actively misleading            |
| `sessions/<pid>.json`            | yes                 | no                         | live-session detection                   |
| `history.jsonl`                  | yes                 | no                         | **prompt archaeology, survives cleanup** |
| `.claude.json` `projects{}`      | yes                 | no                         | canonical real project paths             |

### 3.2 `sessions-index.json` — legacy, stale, must be ignored

```json
{
  "version": 1,
  "originalPath": "/Users/you/work/payments-api",
  "entries": [
    {
      "sessionId": "298e5a7e-…",
      "fullPath": "…/298e5a7e-….jsonl",
      "fileMtime": 1769859834264,
      "firstPrompt": "the webhook retries are firing…",
      "summary": "Webhook retry backoff",
      "messageCount": 6,
      "created": "2026-01-31T11:36:21.354Z",
      "modified": "2026-01-31T11:41:09.081Z",
      "gitBranch": "main",
      "projectPath": "…/payments-api",
      "isSidechain": false
    }
  ]
}
```

Hard evidence that it is dead:

| Observation                                                   | Number                                                                         |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Project dirs with the file                                    | **12 of 40**                                                                   |
| Newest index mtime                                            | **2026-02-03** — 7 months stale                                                |
| Newest transcript mtime                                       | 2026-09-08 (today)                                                             |
| Index files written during E1–E11 (3 new sessions, 8 resumes) | **0**                                                                          |
| `entries[].fullPath` pointing at files that no longer exist   | many (e.g. all 3 in `payments-api`, whose dir now contains _only_ the index) |
| Sessions resumable with **no** index present at all           | all of E1–E11                                                                  |

**Consequences for the PRD**

- §12 `doctor`'s proposed check _"transcripts exist but are missing from Claude's session index"_ would fire on ~100% of sessions on this machine and is **meaningless**. Drop it.
- The inverse — _"index references a missing transcript"_ — is real but describes a dead file, not user harm. Report as informational at most.
- Do not read, write, repair or trust this file. Not even to seed a cache.

### 3.3 `sessions/<pid>.json` — live session registry

```json
{
  "pid": 33412,
  "sessionId": "b3d6a3c0-…",
  "cwd": "/Users/you/work/billing-service",
  "startedAt": 1787912743205,
  "procStart": "Fri Aug 28 10:25:37 2026",
  "version": "2.1.250",
  "kind": "interactive",
  "entrypoint": "cli",
  "pidDomain": "darwin",
  "messagingSocketPath": "/tmp/cc-socks/33412.sock",
  "name": "webhook retries…",
  "nameSource": "user",
  "nameSince": 1787924484696,
  "status": "idle",
  "updatedAt": 1788896667144,
  "formerNames": [{ "name": "webhook retries (Branch)", "until": 1787924484696 }]
}
```

Removed when the session exits; crash leftovers cleared on next launch. **Not** part of the
age sweep. This is the cheap, honest way to answer _"is this session currently open in
another terminal?"_ — which `archive` and `resume` both need (§9.4).

### 3.4 `history.jsonl` — the graveyard index, kept forever

```json
{
  "display": "make this stop deleting…",
  "pastedContents": {},
  "timestamp": 1759242823067,
  "project": "/Users/you/work/payments-api",
  "sessionId": "…"
}
```

| Metric                           | Value                                                                   |
| -------------------------------- | ----------------------------------------------------------------------- |
| Lines                            | 21 031                                                                  |
| Range                            | **2025-09-30 → 2026-09-08** (~12 months — 12× the transcript retention) |
| Records carrying `sessionId`     | 4 158 of 5 000 sampled (older lines lack it)                            |
| Distinct `sessionId`s            | 1 915                                                                   |
| …with **no transcript on disk**  | **1 710 (89 %)**                                                        |
| …on disk but absent from history | 2 (both `-p` spike sessions)                                            |

Docs confirm it is in the _"kept until you delete them"_ set — the retention sweep never
touches it. This is the single most valuable under-used artifact:

- **Confirmed** (not heuristic) proof that 1 710 sessions once existed and are gone → an
  honest `doctor` and an honest "you lost N sessions in the last year" first-run hook.
- Prompt **text** + project + timestamp survive the transcript → `search` can find work whose
  transcript is deleted, and say so plainly ("prompt found, transcript gone, not resumable").
- Deleted only by `claude project purge`, which strips matching lines.

### 3.5 `~/.claude.json` → `projects{}`

73 entries keyed by **real absolute path**, each with `lastSessionId`,
`lastSessionFirstPrompt`, `lastSessionModified`, `hasTrustDialogAccepted`, `mcpServers`,
`allowedTools`, plus per-project last-run metrics. 213 KB, rewritten constantly by Claude.

Use it **read-only** as the authoritative real-path list for reverse-mapping encoded dir
names. Never write it (Claude keeps rolling backups in `~/.claude/backups/` precisely because
it rewrites this file).

---

## 4. Resume behavior — experimentally verified

All experiments used `claude -p --safe-mode --tools "" --permission-prompts none --model sonnet`
on throwaway sessions in throwaway cwds. Verification method: plant a magic token in turn 1,
ask for it back after resume.

| #   | Experiment                                                                      | Result                                                                                                                                                  | Verdict                     |
| --- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| E1  | `--session-id <uuid>` in `…/spike-a`, then exit                                 | `…/projects/-private-tmp-…-scratchpad-spike-a/<uuid>.jsonl` created                                                                                     | ✅                          |
| E2  | `--resume <uuid>` from the **original** cwd                                     | returned `ZEBRA-8842-QQ`                                                                                                                                | ✅ exact session            |
| E2b | file after E2                                                                   | **same file appended** (14→21 lines), same `sessionId`, no fork, no new file, **no index written**                                                      | ✅ resume is in-place       |
| E3  | `--resume <uuid>` from an **unrelated** cwd (repo root)                         | returned `ZEBRA-8842-QQ`; transcript **stayed** in `spike-a`'s dir; new records carry the **new** `cwd`                                                 | ✅ but see ⚠ below          |
| E4  | archive B (`cp -p` outside `~/.claude` + manifest), move original aside, resume | `No conversation found with session ID: 336ff45c-…`                                                                                                     | ✅ negative control         |
| E5  | restore B's copy into a **different** project dir, resume                       | returned `FALCON-7731-ZZ`                                                                                                                               | ✅ physical dir irrelevant  |
| E6  | move B into its **correct** project dir, resume                                 | returned `FALCON-7731-ZZ`                                                                                                                               | ✅                          |
| E7  | **two** copies of B (spike-a + spike-b dirs), resume from a third cwd           | `No conversation found with session ID: …`                                                                                                              | ⚠ **duplicate ⇒ not-found** |
| E8  | remove the duplicate, resume again                                              | returned `FALCON-7731-ZZ`                                                                                                                               | ✅ recoverable              |
| E9  | `--resume 26372108` (8-char prefix)                                             | `Error: --resume requires a valid session ID or session title when used with --print. … "26372108" is not a UUID and does not match any session title.` | ❌ no prefix matching       |
| E10 | `--resume "Spike B archive test"` (exact title)                                 | returned `FALCON-7731-ZZ`                                                                                                                               | ✅ title is a resume handle |
| E11 | session in cwd `…/spike.c d-ü`                                                  | dir `…-scratchpad-spike-c-d--`                                                                                                                          | ✅ encoding rule            |

### 4.1 Resolution order (docs, matches E3/E5/E7)

```
claude --resume <uuid>
   1. current project dir + its git worktrees
   2. every other project dir on the machine        ← added in v2.1.223
        └─ resolves ONLY if exactly ONE other project holds a transcript
           with messages for that id; otherwise → "No conversation found"
   3. no match → "No conversation found with session ID: <id>"   (picker path: exit 1,
                                                                  "Failed to resume the conversation")
```

Before v2.1.223 the lookup stopped at step 1 → **on older CLIs you must `cd` first.**

### 4.2 Consequences for `termstash resume`

1. **Short IDs are ours to expand.** `7f31a2` is not a Claude concept (E9). Resolve the prefix
   to a full UUID ourselves, error clearly on ambiguity, then pass the full UUID.
2. **`cd` into `projectPath` first, then exec.** E3 proves resume-from-anywhere works but
   pollutes the transcript with a foreign `cwd`, and the session then loads the _wrong_
   project's `CLAUDE.md`, permissions, agents and MCP config. Also restores compatibility with
   pre-2.1.223 CLIs.
3. **Exec, don't spawn-and-pipe.** Resume is interactive; hand the TTY over
   (`execvp`-equivalent) so Claude owns stdin/stdout and our process disappears.
4. **Never pass a title as the handle.** Titles collide (E10 works only on exact unique match)
   and Claude falls back to opening a picker on ambiguity.
5. Resume restores conversation, model, agent and permission mode; it does **not** restore
   `--mcp-config`, `--settings`, `--plugin-dir`, `--fallback-model` or `--add-dir`. If we ever
   grow a config-passthrough feature, that is the list.

### 4.3 Sessions Claude's own UI hides — our differentiator

Claude's `/resume` picker and `--continue` deliberately exclude:

- sessions created with `claude -p` or the Agent SDK (resumable **only** by explicit ID),
- background sessions (from `--continue`),
- sessions whose **first** prompt was `/loop`,
- and by default everything outside the current worktree (Ctrl+W / Ctrl+A to widen).

A flat, global, ID-addressable list is therefore genuinely more capable than the native
picker, not just prettier.

---

## 5. Cleanup behavior

### 5.1 The rule

| Property       | Value                                                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Setting        | `cleanupPeriodDays` in `settings.json`                                                                                         |
| Default        | **30**                                                                                                                         |
| Minimum        | **1** — `0` **fails validation** (it does _not_ mean "keep forever")                                                           |
| Timestamp used | **file mtime** ("last activity"), not `createdAt`                                                                              |
| Cadence        | once per sweep run; `~/.claude/.last-cleanup` holds the last run (here `2026-09-08T12:49:59.021Z`)                             |
| Local proof    | oldest surviving main transcript `2026-08-09`, newest `2026-09-08` → **exactly a 30-day window**, 143 files in Aug + 69 in Sep |

### 5.2 What the sweep deletes (docs, `~/.claude/`-relative)

```
projects/<p>/<session>.jsonl                        ◀ the session itself
projects/<p>/<session>.orphaned-<ts>-<suffix>.jsonl ◀ set-aside older transcripts
projects/<p>/<session>.jsonl.superseded-<ts>        ◀ (none present on this machine)
projects/<p>/<session>/subagents/                   removed with the parent
projects/<p>/<session>/tool-results/
file-history/<session>/   plans/   debug/   paste-cache/
image-cache/<session>/    ← all other sessions' dirs are wiped on EVERY sweep, any age
uploads/<session>/   session-env/   tasks/   shell-snapshots/   backups/
feedback-bundles/   feedback/drafts/ (min(cleanupPeriodDays,30))   usage-data/
todos/ statsig/ logs/ (legacy, contents + dir)
```

Exempt / special:

| Path or case                                                                                  | Behavior                                                                                                                                             |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `projects/<p>/memory/`                                                                        | auto-memory; dir removed only if empty for the whole period (regression before v2.1.228)                                                             |
| `sessions/`                                                                                   | not age-swept; per-process lifecycle                                                                                                                 |
| `history.jsonl`, `stats-cache.json`, `.credentials.json`, `agent-memory/`, `jobs/`, `daemon/` | **kept until you delete them**                                                                                                                       |
| Claude Desktop / Cowork sessions                                                              | **exempt at any age** by default (v2.1.248+); limit them with `desktopSessionCleanupPeriodDays`; managed `cleanupPeriodDays` overrides the exemption |
| `claude -p --bare`                                                                            | sweep skipped for that run                                                                                                                           |
| Retention period undeterminable (unreadable/invalid settings)                                 | **sweep pauses**; `/status` warns; `retention_sweep` OTel event lists causes                                                                         |

### 5.3 Local artifacts the sweep leaves behind

- **2 orphaned sidecar dirs** whose `.jsonl` is already gone, holding subagent transcripts
  from **2026-06-21** — 79 days old, i.e. well past the 30-day window.
- **199** `session-env/<uuid>/` dirs vs 209 live sessions.
- **12** stale `sessions-index.json` from Jan–Feb 2026.
- `payments-api`'s project dir survives containing _only_ a stale index.

These are the **real** `doctor` findings — verifiable from the filesystem, not inferred.

### 5.4 `claude project purge` — the fast path to data loss

Deletes, per project, after printing a plan and asking for confirmation
(`--dry-run` previews):
transcripts + `memory/` under `projects/`, per-session `tasks/`/`debug/`/`file-history/`,
**matching prompt lines in `history.jsonl`**, and the project's `~/.claude.json` entry.

A purge therefore destroys even our graveyard evidence. Worth naming in `doctor` output as
the one command that can defeat an archive-less setup.

---

## 6. Discovery without `sessions-index.json` — yes, entirely

Proven: E1–E11 all ran in project dirs that never had an index, and 3 fresh sessions +
8 resumes produced none.

### 6.1 The scan

```
root = (CLAUDE_CONFIG_DIR ?? ~/.claude) / "projects"
for each dir D in root:
  for each entry F in D:
    accept  F  iff  basename(F) matches /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/
    reject  everything else   → .DS_Store, MEMORY.md, sessions-index.json, memory/,
                                <uuid>/ sidecar dirs, *.orphaned-*, *.superseded-*
    NEVER recurse into <uuid>/subagents/  → those are sidechains, and they carry the
                                            PARENT sessionId, so they WILL corrupt the list
  metadata: stream lines from offset 0 until first record with .cwd (cap ~2000 lines / 8 MB)
            + read the tail (~256 KB) for the current custom-title / ai-title
  updatedAt = mtime      createdAt = first .timestamp
```

### 6.2 Measured feasibility on this machine

| Measurement                                                 | Value                                   |
| ----------------------------------------------------------- | --------------------------------------- |
| Sessions enumerated + metadata extracted (head+tail 256 KB) | **208 in 357 ms** (Node 20, warm cache) |
| Corpus                                                      | 209 files / 399.4 MB                    |
| Zero-byte files                                             | 0                                       |
| Unparsable JSON lines (all files < 2 MB fully parsed)       | **0**                                   |
| Same session id in two project dirs                         | 0                                       |
| Naive full-text `grep -ril` over the whole corpus           | 0.22 s warm (expect ~1–3 s cold)        |

**No index and no database is needed for v0.2.** A streaming scan satisfies PRD v0.2 §29, and
the per-session parse is fast enough to run on every `list`. If a cache is ever added, key it
on `(path, size, mtimeMs)` and treat it as disposable.

---

## 7. Archive / restore feasibility

### 7.1 Verified round trip (E4 → E8)

```
        ~/.claude/projects/<enc-B>/336ff45c….jsonl        ← live session B
                        │  cp -p  (mtime preserved, original untouched)
                        ▼
  ~/.termstash/archive/336ff45c…/ transcript.jsonl + manifest.json      [outside ~/.claude]
                        │
   ── original moved aside (simulating the 30-day sweep) ──────────────
                        │
   claude --resume 336ff45c…   →  "No conversation found with session ID: …"      E4 ✅
                        │
                        │  copy transcript.jsonl back as <session-uuid>.jsonl
                        ▼
   into a DIFFERENT project dir  →  resume OK, token recalled                    E5 ✅
   into the CORRECT project dir  →  resume OK, token recalled                    E6 ✅
```

### 7.2 Minimum restore set

**One file.** `<session-uuid>.jsonl`, placed anywhere under
`~/.claude/projects/<any-dir>/`, is sufficient for `claude --resume <uuid>`.

Everything else is fidelity, not resumability:

| Also archive            | Why                                                                                   | Restore required?               |
| ----------------------- | ------------------------------------------------------------------------------------- | ------------------------------- |
| `<uuid>/tool-results/*` | transcript references these paths; without them large tool outputs are dangling       | no — resume works, content lost |
| `<uuid>/subagents/*`    | subagent transcripts, for search/inspection                                           | no                              |
| `file-history/<uuid>/`  | `/rewind` checkpoints                                                                 | no                              |
| `session-env/<uuid>/`   | env metadata                                                                          | no                              |
| our `manifest.json`     | `sessionId`, `projectPath`, encoded dir, `claudeVersion`, `archivedAt`, mtime, sha256 | ours                            |

### 7.3 The one dangerous edge — duplicates (E7)

> Cross-project resolution succeeds _only when exactly one other project holds a transcript
> with messages for that id._ Two copies ⇒ `No conversation found`.

So a careless `restore` that leaves both the archived copy and a still-live original in
`~/.claude/projects/` **breaks a session that worked a moment earlier.** It is fully
recoverable (E8: delete one copy) but it is exactly the class of bug PRD v0.2 §35 forbids.

**Mandatory restore contract**

```
1  refuse if the id is in ~/.claude/sessions/*.json          (live in another terminal)
2  scan ALL project dirs for <uuid>.jsonl  (and .orphaned-/.superseded- variants)
     0 found → restore to manifest.projectDir (create dir; mkdir -p) → verify → done
     1 found → DO NOT WRITE unless --replace is passed. With it, the existing
               transcript is quarantined and verified before removal (PRD v0.2 §21 Step 2a)
    ≥2 found → DO NOT WRITE. this is the broken state; report it and name the paths
3  write to a temp file in the target dir, fsync, then rename() into place  (atomic)
4  set mtime = NOW  (see correction note below)             manifest.sourceMtime is kept as a fact
5  verify: sha256 matches, JSON parses, internal sessionId == filename basename
6  print the exact resume command; do NOT claim success beyond what was verified
```

`archive` is trivially safe: `cp -p` + manifest, never move, never touch the original, refuse
to overwrite an existing archive without an explicit flag.

> **Correction (2026-09-12).** Step 4 originally read *"restore mtime from the manifest
> (preserves cleanup semantics)"*. That was wrong. Cleanup deletes by mtime (§5.1), so a
> transcript restored with its original, old mtime is immediately eligible for the next
> retention sweep — the restore would survive only until Claude's next launch. A restored
> transcript is a newly reintroduced live copy and must receive the **current** mtime.
> `manifest.sourceMtime` keeps the historical value, and `lastMessageAt` (read from the
> transcript body) keeps display recency honest. Adopted in PRD v0.2 §21.


### 7.4 The supported, non-scraping archive trigger

Docs: hooks and statusline commands receive a **`transcript_path`** input field, and
_"a `SessionEnd` hook can archive the transcript when a session ends."_

That is a documented, version-stable contract. `termstash` should offer to install a
`SessionEnd` hook for auto-archiving pinned sessions rather than polling the filesystem —
it closes the `protected-stale` window defined in PRD v0.2 §17.

### 7.5 Making `pin` honest (PRD v0.2 §17)

Pinning cannot stop Claude's sweep. Two mechanisms actually preserve data:

| Mechanism                                         | Honest claim                                                                                                                            |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Archive a copy outside `~/.claude`                | "the conversation is preserved and restorable" ✅                                                                                       |
| `SessionEnd` hook auto-archive of pinned sessions | "pinned sessions are archived automatically" ✅                                                                                         |
| Touching mtime to defeat the sweep                | ❌ never — it is a write to Claude-owned data, it lies to Claude's own picker sort, and it is exactly what PRD v0.2 §5.3 forbids |

So: `pin` = our metadata + auto-archive intent. Never advertise deletion protection without
an archive behind it.

---

## 8. OS differences

|                                | macOS                                   | Linux                | Windows                                                            |
| ------------------------------ | --------------------------------------- | -------------------- | ------------------------------------------------------------------ |
| Config root                    | `~/.claude`                             | `~/.claude`          | `%USERPROFILE%\.claude`                                            |
| Transcripts                    | `~/.claude/projects/<enc>/<uuid>.jsonl` | same                 | `…\projects\<enc>\<uuid>.jsonl`                                    |
| Override                       | `CLAUDE_CONFIG_DIR`                     | `CLAUDE_CONFIG_DIR`  | `CLAUDE_CONFIG_DIR`                                                |
| Dir-name encoding              | `[^a-zA-Z0-9] → '-'`                    | same                 | same — **drive letter collapses**: `C:\Users\x\p` → `C--Users-x-p` |
| Path separator inside `cwd`    | `/`                                     | `/`                  | `\` (in the JSON `cwd` value)                                      |
| Case sensitivity               | usually **insensitive** (APFS default)  | sensitive            | insensitive                                                        |
| Junk files                     | `.DS_Store` (4 found)                   | —                    | `Thumbs.db`, `desktop.ini`                                         |
| `sessions/<pid>.json`          | `"pidDomain": "darwin"`                 | `"linux"` presumably | differs — treat as opaque                                          |
| 200-char dir truncation + hash | yes                                     | yes                  | yes, and `MAX_PATH` bites sooner                                   |

Portability rules for the adapter:

1. Resolve the root as `process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude')`.
   Do not hand-roll `~` expansion.
2. `path.join` everywhere; never string-concatenate; never assume `/` in a `cwd` value.
3. Compare paths case-insensitively on `darwin`/`win32`, case-sensitively on `linux`.
4. Ignore unknown files rather than erroring — junk files vary by OS.
5. `resume` must `cd` via the child process's `cwd` option, not a shell `cd &&` string
   (quoting, spaces, `cmd.exe`).
6. Never assume `~/.claude` and the archive live on the same filesystem: `copy` then `rename`
   within the target dir, never `rename` across roots.

---

## 9. Unknowns and risks

### 9.1 Risk register

| #   | Risk                                                                                                                                                                                        | Severity | Evidence             | Mitigation                                                                                                                                                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | **Format is explicitly unstable.** Docs: _"The entry format is internal to Claude Code and changes between versions, so scripts that parse these files directly can break on any release."_ | **High** | official docs        | version-tag the adapter; parse defensively (unknown `type` → ignore); never hard-fail a scan on one bad session; CI matrix over recorded fixtures from several `version` values; surface `unsupported format` as a warning per PRD v0.2 §5.2 |
| R2  | Restoring a duplicate breaks a working resume                                                                                                                                               | **High** | E7                   | §7.3 restore contract                                                                                                                                                                                                                  |
| R3  | Two terminals resuming the same session interleave into one transcript                                                                                                                      | Med      | docs                 | refuse `resume` when `sessions/*.json` shows the id live; suggest `--fork-session`                                                                                                                                                     |
| R4  | `cp` without `-p` resets mtime → resets cleanup clock, breaks sorting                                                                                                                       | Med      | §2.4                 | always preserve times; store mtime in the manifest                                                                                                                                                                                     |
| R5  | `~/.claude.json` is rewritten constantly and is 213 KB                                                                                                                                      | Med      | observed             | read-only, tolerate mid-write parse failure, never write                                                                                                                                                                               |
| R6  | Transcripts are **plaintext secrets** — `.env` contents, tokens, command output all land in the `.jsonl`                                                                                    | **High** | official docs        | archive dir `0700`, files `0600`; never print raw transcript bodies in `search` without truncation; `--no-transcript` search mode; say this loudly in the README                                                                       |
| R7  | `CLAUDE_CODE_PROJECT_DIR_NAME` (v2.1.234+) decouples dir name from path                                                                                                                     | Low      | docs                 | already solved by reading `cwd` (§1.1)                                                                                                                                                                                                 |
| R8  | `claude project purge` destroys transcripts **and** the `history.jsonl` evidence                                                                                                            | Med      | docs                 | document; recommend archiving before purge                                                                                                                                                                                             |
| R9  | Desktop/Cowork sessions never age out; managed settings can override                                                                                                                        | Low      | docs                 | don't promise a uniform retention story                                                                                                                                                                                                |
| R10 | Legacy `type:"summary"` records (0 on this machine) exist in older corpora                                                                                                                  | Low      | absence is not proof | keep a fallback branch                                                                                                                                                                                                                 |
| R11 | Pre-2.1.223 CLIs can't resume by id from another dir                                                                                                                                        | Low      | docs                 | we `cd` anyway                                                                                                                                                                                                                         |

### 9.1a Compaction — resolved 2026-09-13

`/compact` does **not** rewrite or truncate the transcript. It reduces what is sent to the
model on subsequent requests; the file keeps every turn.

Verified against a real session compacted twice (849K→18K tokens, then 766K→19K, 1.5M
cumulative dropped). The file held 3,828 records, with the compaction boundaries at lines
1,123 and 2,310 — and all 77 user turns preceding the first boundary were intact and
searchable.

It surfaces as fields on existing record types, not new ones:

```
system record   compactMetadata: { trigger, preTokens, postTokens,
                                   cumulativeDroppedTokens, preservedSegment, … }
user record     isCompactSummary: true    ← the generated summary turn
```

Consequence for search: full history remains available, including turns the model itself can
no longer see. An archive taken after compaction is still a complete record of the session.

### 9.2 Genuine unknowns (not resolved by this spike)

1. **Windows/Linux behavior is documentation-only.** Every experiment ran on macOS. The drive-letter encoding, `pidDomain`, and `\`-in-`cwd` claims are inferred, not observed.
2. **`.orphaned-<ts>-<suffix>.jsonl` / `.jsonl.superseded-<ts>`** — documented but absent here. Shape of the suffix, and whether `--resume` prefers or ignores them, untested.
3. **`/branch` and `--fork-session`** create new ids; the picker "groups multiple entries for the same session". The on-disk linkage between a branch and its parent was not identified — no `parentSessionId` field was observed. Branch lineage is currently invisible to us.
4. ~~**Compaction (`/compact`)**~~ — resolved on 2026-09-13, see §9.1a. It does not rewrite the transcript; every turn survives on disk and stays searchable.
5. **Cross-machine restore.** An archive restored on a different machine will carry a foreign `cwd`; whether Claude tolerates a non-existent `cwd` on resume was not tested (docs hint it falls back to the current directory).
6. **Exact sweep trigger.** `.last-cleanup` implies at most once per day, but the trigger (startup? first session of the day?) wasn't instrumented.
7. **`--resume` on a live session** — refused, or interleaved? Not tested (would have disturbed real sessions).
8. **Scale.** 209 sessions / 399 MB here. A user with 2 000+ sessions is plausible (an existing Rust tool advertises exactly that); our 357 ms becomes ~3.5 s and the full-text scan grows linearly.

### 9.3 Prior art

Existing OSS already covers parts of this: `cc-deck/cc-session` (Rust CLI+TUI, claims 2 000+
sessions under 500 ms, searches project/branch/message text), `borball/claude-session-manager`
(VS Code), `paull78/claude-session-manager` (plugin, cross-repo dashboard),
`hex/claude-sessions`. **Nobody appears to own archive/restore against the 30-day sweep, or
the `history.jsonl` graveyard.** That — not `list`/`search` — is the gap this leaves open.

---

## 10. Recommended implementation approach

> **Kept for rationale, not as a plan (2026-09-12).** What actually got built, and in what
> order, is the code and `CHANGELOG.md`. This section records the reasoning that led there,
> including the places where the spike's first reading turned out to be wrong.

### 10.1 Decisions this spike settles

| #   | Decision                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **Ignore `sessions-index.json` completely.** Discovery = filesystem scan. Delete that check entirely (PRD v0.2 §23 forbids it).                         |
| D2  | **The `.jsonl` is the only source of truth.** Filename UUID == `sessionId` (209/209).                                                                   |
| D3  | **Never decode the project dir name.** `projectPath` comes from the first record's `cwd`. Cross-check against `~/.claude.json.projects` keys.           |
| D4  | **`updatedAt` = mtime**; also expose `lastMessageAt` = last `.timestamp`.                                                                               |
| D5  | **Title** = last `custom-title` → last `ai-title` → cleaned first user prompt. Half of all sessions need the fallback.                                  |
| D6  | **`resume`** = expand short id → look up `projectPath` → spawn `claude --resume <full-uuid>` with `cwd: projectPath` and inherited stdio. Nothing else. |
| D7  | **`archive`** = `cp -p` + `manifest.json` into `~/.termstash/archive/<uuid>/`, `0700`/`0600`, never move, never overwrite silently.                    |
| D8  | **`restore`** = the exact contract in §7.3. Duplicate detection is not optional.                                                                        |
| D9  | **`pin`** = our metadata **plus a verified archive, mandatory from the first release** (PRD v0.2 §17), with protection states `protected-current` / `protected-stale`. The `SessionEnd` hook is a later convenience, not the mechanism. Never touch mtimes of live transcripts. |
| D10 | **No database, no index file in v0.2.** 357 ms scan / sub-second grep. Optional disposable cache keyed on `(path,size,mtimeMs)`.                        |
| D11 | **`doctor` reports only filesystem-verifiable facts** (§10.4; authoritative list: PRD v0.2 §23).                                                                                          |
| D12 | Parse defensively and version-tag the adapter (R1).                                                                                                     |

### 10.2 Normalized model, refined from PRD v0.1 §17

> Authoritative version: **PRD v0.2 §9.1** — it adds `projectPathExists` and `retention{}` and
> drops `messageCount`. **§26** is authoritative for our own metadata. The sketch below is the
> reasoning that produced them.

```ts
// facts read from Claude — never written back
type ClaudeSession = {
  id: string; // uuid, == filename basename, == internal sessionId
  agent: "claude-code";
  agentVersions: string[]; // distinct .version seen; multi = resumed across upgrades
  sourcePath: string; // absolute .jsonl path
  projectDirName: string; // encoded bucket. opaque. never decoded
  projectPath?: string; // first record .cwd. absent for 4/209 here
  projectName?: string; // basename(projectPath)
  cwdHistory?: string[]; // a session CAN span cwds (E3, /cd)
  gitBranch?: string;
  title?: string;
  titleSource?: "custom" | "ai" | "first-prompt";
  createdAt?: Date; // first .timestamp
  updatedAt: Date; // file mtime  ← sort key
  lastMessageAt?: Date; // last .timestamp
  sizeBytes: number;
  messageCount?: number;
  origin: "interactive" | "sdk-cli"; // .entrypoint — sdk-cli is hidden from Claude's picker
  isLive: boolean; // present in ~/.claude/sessions/*.json
  hasSubagents: boolean;
  hasToolResults: boolean;
  parseWarnings: string[]; // feeds doctor. never thrown away
};

// ours, in ~/.termstash/ — strictly separate (PRD v0.2 §26)
type SessionMetadata = {
  sessionId: string;
  pinned?: boolean;
  autoArchive?: boolean;
  archives?: {
    path: string;
    archivedAt: Date;
    sha256: string;
    sourceMtime: Date;
  }[];
  notes?: string;
};

// a session that history.jsonl proves existed but whose transcript is gone
type LostSession = {
  id: string;
  projectPath: string;
  firstSeen: Date;
  lastSeen: Date;
  promptCount: number;
  prompts: string[];
  resumable: false; // always. be explicit in the UI
};
```

### 10.3 Adapter shape

```
core/                       knows nothing about Claude
  session, metadata, archive, search, shortid
adapters/claude/
  paths.ts        CLAUDE_CONFIG_DIR ?? ~/.claude ; projects root ; sessions root
  scan.ts         enumerate <uuid>.jsonl, reject junk, never recurse into subagents/
  parse.ts        streaming head-until-cwd + tail-for-title; unknown types ignored
  liveness.ts     read sessions/<pid>.json
  history.ts      history.jsonl → LostSession[]   ← the graveyard
  resume.ts       spawn('claude', ['--resume', id], { cwd: projectPath, stdio: 'inherit' })
  archive.ts      cp -p + manifest ; restore per §7.3
```

`AgentAdapter` needs more members than PRD v0.1 §16 sketched (final shape: PRD v0.2 §31), both driven by findings above:

```ts
interface AgentAdapter {
  discoverSessions(): Promise<Session[]>;
  resume(session: Session, cwd: string): Promise<never>; // cwd is an explicit input, PRD v0.2 §15
  isLive(id: string): Promise<boolean>; // R3
  discoverLostSessions?(): Promise<LostSession[]>; // §3.4 — Claude-specific but valuable
}
```

### 10.4 `doctor` — only these checks

| Check                                                                       | Class                                  | How verified                                          |
| --------------------------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------- |
| Orphaned sidecar dir (`<uuid>/` with no `<uuid>.jsonl`)                     | **confirmed**                          | `stat` both paths — 2 found here                      |
| Orphaned `session-env/<uuid>` / `file-history/<uuid>`                       | **confirmed**                          | id absent from the scan — 199 vs 209 here             |
| Pinned session whose archive is stale vs the live transcript                | **confirmed**                          | manifest `sourceMtime`/`sizeBytes` vs live file       |
| Orphaned/superseded artifact with no live `<uuid>.jsonl`                    | **potential**                          | filename scan; behavior unverified — report only      |
| Archive whose live session is gone                                          | **confirmed**                          | manifest vs scan                                      |
| **Same `<uuid>.jsonl` in ≥2 project dirs**                                  | **confirmed — actively breaks resume** | scan; E7                                              |
| Zero-byte or unparsable transcript                                          | **confirmed**                          | 0 here                                                |
| Degenerate transcript (no user turn; e.g. 267-byte `bridge-session`-only)   | **confirmed**                          | 2 here                                                |
| No `cwd` found within the parse cap                                         | **potential**                          | report as "project unknown", not corruption           |
| Unrecognised record types / newer `version` than we were built against      | **potential**                          | warn (PRD v0.2 §23), never "repair"                        |
| Sessions approaching the retention cutoff (mtime > `cleanupPeriodDays − 7`) | **informational + actionable**         | mtime + effective setting → "archive these"           |
| `history.jsonl` ids with no transcript                                      | **informational**                      | 1 710 here → "N sessions were swept in the last year" |
| ~~missing from `sessions-index.json`~~                                      | **REMOVED**                            | the index is dead (§3.2)                              |

### 10.5 First-run hook, backed by real numbers

`doctor` on this machine truthfully reports: **209 sessions live, 399 MB, oldest 30 days old,
1 710 sessions swept in the last year, 2 orphaned artifacts.** The swept count is the one a
reader can check on their own machine in five seconds, which is what makes it worth reporting
on first run.

### 10.6 Suggested build order

```
1  adapters/claude: paths + scan + parse            → `list`          (D1–D5, §6.1)
2  short-id resolution + `resume`                   → `resume`        (D6, §4.2)
3  grep-class search over transcripts + titles      → `search`        (§6.2)
4  archive (cp -p + manifest) + restore contract    → `archive` `restore` (D7, D8, §7.3)
5  our metadata store + `pin` (depends on 4)       → `pin` `unpin`   (D9)
6  doctor from §10.4 only                          → `doctor`        (D11)
7  history.jsonl graveyard                         → `doctor`/`search` (§3.4)
8  optional: SessionEnd auto-archive hook          → closes the stale window (§7.4)
```

Archive and restore ship together in step 4, and `pin` depends on them — pinning cannot claim
protection before a verified archive exists. An archive nobody has proven restorable is exactly
the "never claim successful restoration without verifying it" failure PRD v0.2 §35 warns about,
and §7.3's duplicate hazard means a naive restore is worse than none. (This list originally put
`pin` before `archive`; corrected 2026-09-12 to match PRD v0.2 §42.)

---

## 11. Appendix

### 11.1 Reproducing the experiments

```bash
D=$(mktemp -d); SID=$(uuidgen | tr 'A-Z' 'a-z')
cd "$D" && claude -p --session-id "$SID" --safe-mode --tools "" \
  --permission-prompts none --model sonnet "Remember this magic token: T-1. Reply with just OK."
find ~/.claude/projects -name "$SID.jsonl"
cd "$D" && claude -p --resume "$SID" --safe-mode --tools "" \
  --permission-prompts none --model sonnet "What magic token did I give you?"
```

`--safe-mode --tools "" --permission-prompts none` keeps the probe from touching anything:
no hooks, no plugins, no MCP, no tool use, and anything that would prompt is auto-denied.

### 11.2 Sources

Official documentation:

- [Manage sessions](https://code.claude.com/docs/en/sessions) — resume semantics, cross-project lookup and its v2.1.223 boundary, picker exclusions, naming, storage path + encoding + 200-char truncation, `CLAUDE_CODE_PROJECT_DIR_NAME`, format-instability warning, `transcript_path` for hooks
- [Explore the .claude directory](https://code.claude.com/docs/en/claude-directory) — the full swept/kept tables, `cleanupPeriodDays` default 30 / min 1 / `0` invalid, Desktop+Cowork exemption, bare-mode and paused-sweep exceptions, `claude project purge`
- [Data usage](https://code.claude.com/docs/en/data-usage) — 30-day local retention, plaintext-at-rest

Community (cross-checks and prior art):

- [cc-deck/cc-session](https://github.com/cc-deck/cc-session) · [borball/claude-session-manager](https://github.com/borball/claude-session-manager) · [paull78/claude-session-manager](https://github.com/paull78/claude-session-manager) · [hex/claude-sessions](https://github.com/hex/claude-sessions)
- [Claude Code deletes your old session logs after 30 days by default](https://brycewatson.com/blog/28-claude-code-deletes-old-logs/) — note: its claim that `cleanupPeriodDays: 0` keeps sessions forever is **wrong**; the docs state `0` fails validation
- [I investigated the storage location and retention period of Claude Code conversation history](https://dev.classmethod.jp/en/articles/claude-code-conversation-history-retention/) · [How to Resume and Search Claude Code Sessions](https://aq.dev/guides/resume-and-search-claude-code-sessions/) · [Claude Code History guide](https://www.codeagentswarm.com/en/guides/claude-code-history-complete-guide)

Primary evidence: this machine's `~/.claude` (read-only) + experiments E1–E11.
