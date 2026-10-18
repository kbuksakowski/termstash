# TermStash

**Lost a Claude Code session? Get back into it.**

TermStash finds the Claude Code sessions you closed, reopens them in the right project, and
keeps a copy of the ones you can't afford to lose. A CLI and a Claude Code plugin.

<img src="https://raw.githubusercontent.com/kbuksakowski/termstash/main/.github/assets/ask.gif" alt="typing 'i lost my session' into Claude Code; Claude lists the most recently closed sessions and gives the termstash resume command" width="820">

## Use it

**In Claude Code** — install the plugin once, then just say you lost a session:

```
/plugin install termstash --marketplace kbuksakowski/termstash
```

**In a terminal** — no install needed:

```
$ npx termstash last

Recently active sessions that are no longer open

  ID      PROJECT          LAST ACTIVE  SESSION
  91bc22  payments-api     2m ago       Redis connection pool
  aa71f9  web-client       yesterday    Checkout timeout
  3e8fee  billing-service  4d ago       Invoice rounding

Resume the most recent:
  termstash resume 91bc22
```

`resume` opens Claude in that session's own project directory, wherever you run it from.
Without installing, resume with `npx termstash resume 91bc22`.

Both need Node 20.11+ on macOS or Linux. To keep the CLI installed: `npm install -g termstash`.
Local-first, open source, no account.

## Keep the sessions that matter

Claude Code deletes a session's transcript 30 days after you last touched it, and raising
`cleanupPeriodDays` is [not](https://github.com/anthropics/claude-code/issues/41458) a
[guarantee](https://github.com/anthropics/claude-code/issues/59248). `pin` keeps a verified copy
outside Claude's directory; `restore` puts it back when Claude has deleted the original:

<img src="https://raw.githubusercontent.com/kbuksakowski/termstash/main/.github/assets/restore.gif" alt="pinning a session, deleting its transcript as Claude's sweep would, and restoring it" width="820">

`termstash hook install` keeps pinned sessions archived after every turn. A session you never
pinned cannot be brought back, but `search` still finds its prompts in Claude's history.

## Commands

```bash
termstash last                      # sessions you were last in that are no longer open
termstash list                      # every session on the machine, newest first
termstash search stripe             # titles, projects, prompts and replies
termstash resume 91bc22             # resume by short id, in the right project
termstash pin 91bc22                # mark important + keep a verified archive
termstash pin --at-risk             # the same, for every session near the 30-day cutoff
termstash restore 91bc22            # bring an archived session back
termstash rename 91bc22 "Pool fix"  # a title you'll recognise in the list
termstash doctor                    # what is at risk, broken or already lost
termstash hook install              # keep pinned sessions archived automatically
```

Six characters of an id are usually enough; an ambiguous one is refused, not guessed.
`--json` works on `list`, `last`, `search` and `doctor`. `termstash --help` has the rest.
`list`, `last`, `search` and `doctor` only read; nothing is written until you `pin`, `archive`,
`restore`, `rename` or install the hook.

`list` marks each session:

```
★  pinned, and the archive is current      ●  open in another Claude process
☆  pinned, but the archive is behind       ⚠  approaching the retention cutoff
▪  only the archive is left
```

## From inside Claude Code

The plugin adds one skill, `termstash:find-session` (Claude Code 2.1.275 or later). It runs the
CLI through `npx` when TermStash is not installed and never runs `resume` itself.

Claude can also manage the session it is in, through `CLAUDE_CODE_SESSION_ID`:

```bash
termstash pin "$CLAUDE_CODE_SESSION_ID"
termstash rename "$CLAUDE_CODE_SESSION_ID" "Pool fix"
```

Exit codes are 0 on success and 1 on a refusal or failure, and no command stops to ask a
question.

## Privacy

Claude Code transcripts are plaintext and can contain secrets. TermStash never uploads
anything and has no telemetry. Its archives in `~/.termstash` are private to your user
(`0700`/`0600`), and it never edits Claude's transcripts.

## More

- [`TECHNICAL-SPIKE.md`](https://github.com/kbuksakowski/termstash/blob/main/TECHNICAL-SPIKE.md) — how Claude Code stores sessions, and the experiments behind every claim here
- [`CHANGELOG.md`](https://github.com/kbuksakowski/termstash/blob/main/CHANGELOG.md) — what changed, per release
- [Issues](https://github.com/kbuksakowski/termstash/issues) for bugs and ideas; anything that could expose transcript content goes to **oss@kamilbuksakowski.dev** ([`SECURITY.md`](https://github.com/kbuksakowski/termstash/blob/main/.github/SECURITY.md)). Pull requests are not accepted ([`CONTRIBUTING.md`](https://github.com/kbuksakowski/termstash/blob/main/CONTRIBUTING.md)).

MIT licensed.
