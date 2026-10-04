import { VERSION } from "./version.js";

/**
 * Its own module so it can be asserted on without importing the entry point,
 * which runs `main()` on load. The footer here once claimed TermStash never
 * writes to Claude's storage, which `restore` and `hook install` both
 * contradict, and nothing could check it.
 */
export const HELP = `termstash ${VERSION}
Your Claude Code sessions expire. Keep the important ones.

Usage
  termstash <command> [options]

Commands
  list                 List Claude Code sessions, newest first
  search <query>       Search titles, projects and conversation text
  resume <id>          Resume a session in its original project directory
  rename <id> <title>  Give a session a title of your own
  pin <id>             Mark important and keep a verified archive of it
  unpin <id>           Remove the mark; the archive is kept
  archive <id>         Copy a session outside Claude's cleanup lifecycle
  restore <id>         Bring an archived session back, duplicate-safe
  doctor               Report at-risk, broken and orphaned session data
  hook install         Keep pinned sessions archived automatically

Options for list
  --project <name>     Only sessions whose project matches
  --live               Only sessions currently open in another Claude process
  --at-risk            Only sessions approaching Claude's retention cutoff
  --pinned             Only pinned sessions
  --limit <n>          Show at most n sessions
  --json               Emit the normalized session records as JSON

Options for resume
  --cwd <dir>          Working directory, required when the original is gone

Options for search
  --limit <n>          Show at most n matches
  --json               Emit matches as JSON

Options for rename
  --clear              Remove a title you set, back to Claude's own

Options for hook install
  --uninstall          Remove the hook from Claude's settings

Options for doctor
  --details            Show the paths behind each finding
  --json               Emit the report as JSON

Options for archive and restore
  --replace            archive: refresh an archive that is behind the transcript
                       restore: displace an existing transcript into quarantine

Global
  -h, --help           Show this help
  -v, --version        Show the version

TermStash only reads Claude Code's storage, except where you ask it not to:
'restore' writes a transcript back, and 'hook install' edits settings.json.
`;
