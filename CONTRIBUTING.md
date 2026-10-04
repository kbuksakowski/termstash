# Contributing to TermStash

**Issues are welcome. Pull requests are not accepted.**

TermStash is maintained by one person, and it handles the only copies of conversations people
cannot get back. Every change goes through the same verification before it ships, and that is
easier to keep honest when every change comes from the same place. Forking is fine — the code
is MIT.

What helps most is an issue:

- **A bug.** The command you ran, what it printed, and what you expected. `termstash doctor
  --json` and your Claude Code version (`claude --version`) usually answer the first question
  before it is asked. Leave out transcript content — paths and ids are enough. Its output
  names your project directories; replace any you would rather not publish.
- **Something that should exist.** What you were trying to do when you missed it. That is worth
  more than a design.
- **A comment you could not follow.** See below.

Anything that could expose someone's transcript content goes to **oss@kamilbuksakowski.dev**,
not a public issue — see [`.github/SECURITY.md`](.github/SECURITY.md).

## What is out of scope

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
rather than guessed at. If you run it there, an issue saying what happened is welcome.

## The `PRD v0.2 section N` comments

The source carries about sixty of these. They point at an internal design document that is not
published — it records decisions made before the first release and is frozen, so publishing it
would mean maintaining a second description of the code that drifts from the code.

The comments are written to stand on their own; the citation is a breadcrumb, not the
explanation. Where the reasoning is about how Claude Code actually stores sessions, it is in
[`TECHNICAL-SPIKE.md`](TECHNICAL-SPIKE.md), which is published in full. If a comment leaves you
guessing, that is a bug in the comment — open an issue and it gets rewritten.

## Building from source

Node 20.11 or newer.

```bash
npm install
npm test          # vitest, no network, no real ~/.claude
npm run typecheck # tsc --noEmit
npm run build     # tsup
npm run smoke     # build, then end-to-end checks against a synthetic home
```

Tests set `CLAUDE_CONFIG_DIR` and `TERMSTASH_HOME` to a temporary directory and refuse to run if
either resolves to the real one. Runtime dependencies are zero by design.
