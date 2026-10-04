# Contributing to TermStash

TermStash handles other people's work — transcripts of sessions they cannot get back. That
constrains what a change is allowed to do more than it constrains how it is written. The rules
below exist for that reason, not for style.

## Before you write code

**Open an issue first for anything that changes behaviour.** Bug reports and small fixes can go
straight to a pull request. Features, new commands, and new flags are worth ten minutes of
agreement before they are worth an afternoon of implementation.

The scope is deliberately narrow. TermStash finds Claude Code sessions, keeps the important
ones safe, and lets you resume them later. Deliberately out, and not by oversight:

- other agents — Codex, Gemini — until people using this one ask for them
- cloud sync, accounts, payments, shared sessions, team workspaces, remote machines
- a web dashboard, agent orchestration, task assignment, SSO, RBAC, enterprise self-hosting
- AI summaries, embeddings, vector search
- automatic code backup, transcript synchronisation
- reconstructing branch and fork lineage, or acting on orphaned artifacts — in both cases
  because the spike found no reliable data on disk to act on, not because it would be hard

Windows is out for a different reason: nobody has tested it, so it is declared unsupported
rather than guessed at. That one is open to whoever runs it.

## The rules that are not negotiable

This product handles data people cannot re-create, and every rule below comes from something
the technical spike established about how Claude Code actually stores sessions. They are
enforced in review:

1. **Never modify, move, or delete a Claude-owned session file.** TermStash reads them and
   copies them. That is all.
2. **Never modify the mtime of an existing Claude-owned transcript.** Claude's retention sweep
   deletes by mtime; touching it either hides a session from the sweep or destroys the signal
   the sweep relies on. There is exactly one exception, documented in §5.3: a transcript
   *newly restored by TermStash* gets the current mtime, because it is a new file rather than
   one Claude already manages.
3. **Never write into Claude's configuration.** Not `~/.claude.json`, not
   `sessions-index.json`, not retention settings.
4. **Never claim success without verifying it.** Restore confirms the SHA-256 before it reports
   anything. Apply the same standard anywhere else.
5. **Prefer copy over move**, and never silently overwrite an archive.
6. **Distinguish a confirmed problem from a suspected one.** `doctor` says which is which, and
   so must anything new. Telling users their data is broken on a heuristic is worse than saying
   nothing.

An unknown or unrecognised Claude format is a warning, never an attempted repair.

### A note on the `PRD v0.2 section N` comments

The source carries about sixty of these. They point at an internal design document that is not
published — it records decisions made before the first release and is frozen, so publishing it
would mean maintaining a second description of the code that drifts from the code.

The comments are written to stand on their own; the citation is a breadcrumb, not the
explanation. Where the reasoning is about how Claude Code actually stores sessions, it is in
[`TECHNICAL-SPIKE.md`](TECHNICAL-SPIKE.md), which is published in full. If a comment leaves you
guessing, that is a bug in the comment — open an issue and it gets rewritten.

## Development

Node 20.11 or newer.

```bash
npm install
npm test          # vitest, no network, no real ~/.claude
npm run typecheck # tsc --noEmit
npm run build     # tsup
npm run smoke     # build, then end-to-end checks against a synthetic home
```

CI runs all of these on macOS and Linux, Node 20 and 22.

### Tests never touch a real home directory

Every test sets `CLAUDE_CONFIG_DIR` and `TERMSTASH_HOME` to a temporary directory. A test that
reads the real `~/.claude` will be rejected even if it passes on your machine. The same applies
to demo recordings — `scripts/demo-env.mjs` builds a synthetic corpus for exactly this reason.

### Fixtures are sanitised

Recorded transcripts contain whatever the session contained, including the signed-in user's
email address. `scripts/sanitize-fixture.ts` exists to scrub them, and a leak check gates CI.
Never commit a transcript you have not run it over.

### TypeScript settings are strict on purpose

`strict`, plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. The code parses
files written by another program that can change format without warning; the type system is
doing load-bearing work here. Do not loosen the settings to make a change compile.

Runtime dependencies stay at zero. `vitest` and `tsup` are dev-only, and a pull request adding
a runtime dependency needs to argue for it in the issue first.

## Contributor License Agreement

Before your first pull request is merged, sign the [ICLA](ICLA.md) by adding one line to
`CONTRIBUTORS.md`. It takes a minute and you only do it once.

You keep the copyright to everything you write. What the agreement grants is the right to
sublicense — which is what lets the project change its licence on future releases without
tracking down every past contributor. TermStash is MIT today and there is no plan to change
that; the agreement exists so the decision stays available rather than being foreclosed by the
first merged pull request.

If you would rather not sign, say so in the issue. A well-specified bug report that someone else
implements is still a real contribution, and it is a perfectly reasonable way to help.

## Pull requests

- One concern per pull request.
- Tests for anything that changes behaviour. The suite is fast; there is no excuse.
- Say what you verified and how. "Tested on 200 real sessions" is worth more than a green tick,
  and this project has already shipped one bug that every test passed over.
- Commit messages describe the change, not the file.
