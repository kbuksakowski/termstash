---
name: find-session
description: Find and resume a Claude Code session the user lost track of — the laptop lid closed, the terminal or window was closed or crashed, or they cannot find "that chat about X". Use when the user says they lost, closed, cannot find or want to get back to a session, in any language (e.g. "I lost my session", "I closed it by accident", "where was that chat").
allowed-tools:
  - Bash(termstash last *)
  - Bash(termstash search *)
  - Bash(npx termstash@latest last *)
  - Bash(npx termstash@latest search *)
---

# Find a lost Claude Code session

1. Run `termstash last --json`. Only if that fails with "command not found", run
   `npx termstash@latest last --json` instead. Do not check where it is installed first.
   It returns the sessions the user was most recently in that are no longer open, across every
   project, newest first. The session you are in now is live, so it is never in the list.

2. If the user described the session ("the one about invoices", "from content-lab"), pick the
   entry that matches by title or project. Otherwise the first entry is the most recently closed.
   Show at most three: short id, project, `lastActive`, title. Use `lastActive` for "when" —
   it is already relative to now; `updatedAt` is UTC and needs no `date` call to interpret.
   Do not guess why sessions closed (a crash, a closed window) — the list is simply the most
   recent ones that are not open. Mention `/clear` only if the user says they used it: a
   session ended with `/clear` shows up here too, because `/clear` starts a new session id.

3. Give the user the `resume` command from the JSON, as a line to type in a terminal, e.g.
   `termstash resume 91bc22`. **Never run it yourself**: resume hands a terminal to Claude, and
   from inside this session it refuses and launches nothing. It starts Claude in that session's
   own project directory.

4. If nothing matches, run `termstash search <words from the user's description>` — it also
   finds sessions whose transcript Claude has already deleted, and says when one cannot be
   resumed.

If `searched.scanPartial` is true in the JSON, say that some locations could not be read, so the
session may exist and still not be listed.
