# TermStash for Claude Code

Lost a Claude Code session? Tell Claude, in any language. This plugin adds one skill,
`termstash:find-session`: Claude lists the sessions you most recently closed across every
project, picks the one you describe, and gives you the `termstash resume <id>` line to type in a
terminal, which reopens the session in its own project directory.

It is for Claude Code: it reads the session files Claude Code keeps on your machine.

```
/plugin install termstash --marketplace kbuksakowski/termstash
```

## What it runs

Only two read-only commands of the [TermStash](https://github.com/kbuksakowski/termstash) CLI,
and only when you ask about a lost session:

- `termstash last --json` — the most recently closed sessions;
- `termstash search <words>` — when none of those matches your description.

When the CLI is not installed, it runs the same commands through `npx termstash@0.3.2`, pinned to
a released version. It never runs `resume` itself, writes nothing, and sends nothing anywhere:
TermStash has no network access and no telemetry.

MIT licensed.
