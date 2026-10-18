# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.2] — 2026-10-18

### Changed

- `doctor` reports a Claude Code newer than the last one recorded as a test fixture as
  information, not as a potential problem. Claude ships nearly daily, so every new user's first
  `doctor` carried that warning. A format change is still a potential finding, as an
  unrecognised record type — the actual sign of one.

### Fixed

- The hook no longer depends on Claude's PATH. Claude Code runs hooks through `/bin/sh -c` with
  its own environment, so a bare `termstash` was `command not found` after every turn whenever
  that PATH lacked it — Claude started outside a terminal, or nvm's default moved to a Node
  version TermStash is not installed under — and pinned sessions silently stopped being
  archived. `hook install` now writes `termstash` from PATH with this install's absolute path as
  the fallback, and rewrites an older entry when run again. It refuses to install from `npx`.
- `doctor` reports the hook failing, as a confirmed finding, from what Claude records after each
  turn — only for the command installed now, so running `hook install` again clears it.
- The record types Claude Code writes from 2.1.300 — `api-request`, `api-request-blob`,
  `api-request-shape`, `isolation-latch` — are known, so `doctor` no longer reports them as
  unrecognised. None of them carries what titles, prompts or search read.

## [0.3.1] — 2026-10-18

### Fixed

- Run through `npx`, `termstash last` gives back `npx termstash resume <id>`, in its output and
  in `--json`. It printed `termstash resume <id>`, which fails with command not found when the
  CLI is not installed — and the plugin's skill, which falls back to `npx`, handed that line to
  exactly the people without it.

### Changed

- `--help`, the README and the package description lead with what TermStash is mostly used
  for: finding a session you lost and getting back into it.

## [0.3.0] — 2026-10-18

### Added

- A Claude Code plugin, installed with
  `/plugin install termstash --marketplace kbuksakowski/termstash`. Its one skill,
  `termstash:find-session`, lets you tell Claude you lost a session: Claude finds it with
  `termstash last` and gives you the `resume` line to type. It uses `npx` when the CLI is not
  installed, and never runs `resume` itself.

### Changed

- `termstash last --json` gives each session a `lastActive` ("3m ago") beside the UTC
  `updatedAt`, so an agent reading it neither prints UTC to the user nor runs `date` first.

## [0.2.0] — 2026-10-17

### Added

- `termstash last` — the sessions you were most recently in that are no longer open, across
  every project, newest first, with the command to resume the first. For when the laptop lid
  closed and the terminal came back without the session. `--json` gives each one with its
  `resume` command, for Claude to hand back.

## [0.1.0] — 2026-10-04

First working release. Verified against Claude Code 2.1.269 and 2.1.289 on macOS and Linux.

### Added

- `termstash list` — every session on the machine, newest first, including ones Claude's own
  picker hides (`-p`/SDK sessions, background sessions, sessions outside the current worktree).
  Markers for protection, live, retention risk and unknown retention.
- `termstash search <query>` — streaming full-text across titles, projects, cleaned human
  prompts and transcripts, plus Claude's prompt history, so a query can find work whose
  transcript Claude has already deleted. No index, no external binary.
- `termstash resume <id>` — short-id expansion, launched in the session's own project
  directory. Refuses on an ambiguous id, a live session, or a missing project directory
  (`--cwd` makes that choice explicit).
  Without a terminal to hand over — inside an agent, a script or a pipe — it refuses and
  prints the command to run in one.
- `termstash archive <id>` / `termstash restore <id>` — verified copies outside Claude's
  cleanup lifecycle, with a duplicate-safe restore and a quarantine that is never pruned.
- `termstash pin <id>` / `termstash unpin <id>` — pin means preserved: it creates, verifies or
  refreshes an archive, and says plainly when a session is *not* protected. `pin --at-risk` does
  it for every session approaching the cutoff at once, and says what it will copy first.
- `termstash rename <id> <title>` — give a session a title you will recognise, from the list
  rather than from inside it. Claude names a session after its first prompt, so half of them
  end up called `/commit`. The title is TermStash's own; the transcript is never touched.
- `termstash doctor` — leads with two numbers: sessions already beyond recovery, and sessions
  approaching the cutoff with no archive. Below them, findings classed as confirmed, potential
  or informational; exits non-zero only on a confirmed one.
- `termstash hook install` — `Stop` and `SessionEnd` hooks that keep a pinned session's archive
  current, closing the window where a pin is no longer protection. `Stop` fires after every
  turn and survives a killed terminal. A refresh is a full verified copy, and only when the
  transcript has changed. Touches only pinned sessions, prints nothing, and cannot fail a turn
  or an exit.

### Notes

- Claude Code session transcripts are plaintext and contain secrets, including the signed-in
  user's email address, which Claude writes into every session's context. Archives and
  quarantine are `0700`/`0600`; search snippets are truncated.
- Nothing leaves the machine. No account, no network, no telemetry.
- TermStash never modifies a Claude-owned transcript. The one exception is a transcript it
  restores itself, which receives the current modification time so Claude's retention sweep
  does not immediately delete it again.
