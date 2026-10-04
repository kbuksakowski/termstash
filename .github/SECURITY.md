# Security

## Reporting a vulnerability

Email **oss@kamilbuksakowski.dev**. Please do not open a public issue for anything that could
expose someone's data.

You should get a reply within a few days. This is a personal project, not a staffed one, so
there is no formal SLA — but a report about reading or writing the wrong file gets looked at
first.

## What TermStash touches

Worth stating plainly, because it decides what counts as a vulnerability here.

**It reads Claude Code session transcripts.** Those are plaintext and contain whatever passed
through a tool: source code, command output, environment variables, API keys, and the
signed-in user's email address, which Claude writes into every session's context. A bug that
causes TermStash to copy, print or transmit that content somewhere unintended is a security
bug, even if nothing crashes.

**It writes in exactly five places**, all under directories it owns or was pointed at:

```
~/.termstash/archive/      copies of transcripts
~/.termstash/quarantine/   anything displaced rather than deleted
~/.termstash/metadata.json pins and titles
~/.claude/projects/…       only `restore`, writing back a session Claude deleted
~/.claude/settings.json    only `hook install`, adding two entries
```

It never modifies an existing Claude transcript. The single exception is documented: a
transcript it restores itself receives the current modification time, so Claude's retention
sweep does not immediately delete it again.

**It makes no network requests.** No account, no telemetry, no update check. If you observe
TermStash opening a socket, that is a bug worth reporting.

## Things that are working as intended

- Archives and quarantine are `0700`/`0600`, readable only by the current user. They are not
  encrypted — anyone who can read your `~/.claude` can already read the originals.
- `list --json` and `search --json` emit untruncated transcript-derived text. That is what
  makes them scriptable; treat their output as sensitive.
- Nothing TermStash displaces is deleted. A transcript `restore --replace` would overwrite, an
  archive `archive --replace` would overwrite, and an archive TermStash can no longer read all
  go into quarantine, and nothing ever prunes that directory. Its disk use grows only through
  commands you run.

## Scope

In scope: reading or writing outside the paths above, leaking transcript content, corrupting
a transcript or an archive, or a crafted transcript causing arbitrary code execution.

Out of scope: Claude Code's own behaviour, including its 30-day retention sweep — TermStash
exists because of it. Report those to Anthropic.
