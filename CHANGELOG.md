# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — unreleased

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
- `termstash archive <id>` / `termstash restore <id>` — verified copies outside Claude's
  cleanup lifecycle, with a duplicate-safe restore and a quarantine that is never pruned.
- `termstash pin <id>` / `termstash unpin <id>` — pin means preserved: it creates, verifies or
  refreshes an archive, and says plainly when a session is *not* protected.
- `termstash rename <id> <title>` — give a session a title you will recognise, from the list
  rather than from inside it. Claude names a session after its first prompt, so half of them
  end up called `/commit`. The title is TermStash's own; the transcript is never touched.
- `termstash doctor` — findings classed as confirmed, potential or informational; exits
  non-zero only on a confirmed one.
- `termstash hook install` — `Stop` and `SessionEnd` hooks that keep a pinned session's archive
  current, closing the window where a pin is no longer protection. `Stop` fires after every
  turn and survives a killed terminal; refreshes copy only the bytes added since the last one.
  Touches only pinned sessions, prints nothing, and cannot fail a turn or an exit.

### Notes

- Claude Code session transcripts are plaintext and contain secrets, including the signed-in
  user's email address, which Claude writes into every session's context. Archives and
  quarantine are `0700`/`0600`; search snippets are truncated.
- Nothing leaves the machine. No account, no network, no telemetry.
- TermStash never modifies a Claude-owned transcript. The one exception is a transcript it
  restores itself, which receives the current modification time so Claude's retention sweep
  does not immediately delete it again.
