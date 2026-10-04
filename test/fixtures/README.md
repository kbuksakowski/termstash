# Fixtures

Recorded Claude Code transcripts used as parser input.

**The conversations are scripted and a copy of real work is never committed** — transcripts
carry source code, command output and credentials, and a push is not retractable.

The recordings themselves are real: a scripted prompt was run through an actual Claude Code
build so the fixture reflects the format as it is, not as we imagine it. That is the whole
point of having them. What the sanitizer removes is everything belonging to the machine that
did the recording.

## How they were recorded

```bash
D=$(mktemp -d) && cd "$D"
claude -p --session-id "$(uuidgen | tr 'A-Z' 'a-z')" \
  --safe-mode --tools "" --permission-prompts none \
  "<scripted prompt with no real content>"
```

`--safe-mode --tools ""` disables hooks, plugins, MCP servers and all tool use;
`--permission-prompts none` denies anything that would prompt. Then sanitise:

```bash
npx tsx scripts/sanitize-fixture.ts <recorded.jsonl> <fixture.jsonl> --cwd /fixture/project
```

`tsx` is not a dependency of this project, so `npx` fetches it. That is deliberate — it runs
once per fixture, and a transitive dev dependency that exists for one script is not worth
carrying.

The sanitizer rewrites the home path in both spellings — `/Users/name` and the dashed
`-Users-name` form Claude uses for project directory names — plus the username, hostname and
anything token-shaped, and drops these outright:

- `systemPrompt`, which is Claude Code's own prompt rather than anything of ours,
- `snapshot`, the environment block carrying the recording machine's working directory,
  OS version and shell,
- `rendered`, which repeats an attachment payload as prose and leaked the working directory
  again after `snapshot` was removed,
- account, organisation and bridge-session identifiers.

Both committed fixtures were re-sanitised on 2026-09-27 after the first three of those rules
were added; they shrank by 82%, which is a fair measure of how much had been riding along.

`test/fixtures-leak.test.ts` then checks the result and fails the build if anything slipped
through. Run it before committing a new fixture — but do not treat it as the thing that makes
a fixture safe. It catches known shapes, and it missed the dashed home path until a fixture had
already shipped with one.

## What is here

| Fixture | Claude | Exercises |
| --- | --- | --- |
| `claude-2.1.269/ai-title.jsonl` | 2.1.269 | generated title, `queue-operation`, `atis-latch`, attachment blocks |
| `claude-2.1.269/custom-title.jsonl` | 2.1.269 | `custom-title` + `agent-name` from `-n`, title precedence |
| `claude-2.1.289/first-prompt.jsonl` | 2.1.289 | headless session with **no** `ai-title` — the first-prompt fallback, `cost-state` |
| `claude-2.1.289/custom-title.jsonl` | 2.1.289 | `custom-title` + `agent-name` from `-n` on the current build |

The 2.1.289 pair was recorded on 2026-10-04 with the same prompts as the 2.1.269 pair, and the
first difference showed on the first run: 2.1.269 wrote an `ai-title` for a `claude -p` session,
2.1.289 writes none. The parser already fell back to the first prompt; no fixture had exercised
that path until this one, which is named after it.

Shapes that are easier to write than to record — a malformed line, a degenerate session, the
256 KB head trap, a session spanning two working directories — are built inline in the test
that needs them, using the writers in `test/helpers/sandbox.ts`. Look in `parse.test.ts` and
`doctor.test.ts` rather than here.
