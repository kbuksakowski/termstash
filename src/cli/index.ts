import { parseArgs } from "./args.js";
import { describeError } from "../core/text/safe.js";
import type { ParsedArgs } from "./args.js";
import { listCommand } from "./list.js";
import { resumeCommand } from "./resume.js";
import { archiveCommand } from "./archive.js";
import { doctorCommand } from "./doctor.js";
import { hookInstallCommand } from "./hook-install.js";
import { hookCommand } from "./hook.js";
import { pinCommand, unpinCommand } from "./pin.js";
import { renameCommand } from "./rename.js";
import { restoreCommand } from "./restore.js";
import { searchCommand } from "./search.js";
import { HELP } from "./help.js";
import { VERSION } from "./version.js";
import { err, out, quoted, safe } from "./format.js";


export async function run(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);

  if (args.flags.has("help") || args.flags.has("h") || args.command === "help") {
    out(HELP);
    return 0;
  }
  if (args.flags.has("version") || args.flags.has("v")) {
    out(safe`${VERSION}\n`);
    return 0;
  }
  if (args.command === undefined) {
    out(HELP);
    return 0;
  }

  if (args.command === "list") return listCommand(args);
  if (args.command === "resume") return resumeCommand(args);
  if (args.command === "search") return searchCommand(args);
  if (args.command === "archive") return archiveCommand(args);
  if (args.command === "restore") return restoreCommand(args);
  if (args.command === "rename") return renameCommand(args);
  if (args.command === "pin") return pinCommand(args);
  if (args.command === "unpin") return unpinCommand(args);
  if (args.command === "doctor") return doctorCommand(args);
  if (args.command === "hook") {
    return args.positionals[0] === "install" ? hookInstallCommand(args) : hookCommand(args);
  }

  // `quoted` caps it. argv is the user's, but a shell expansion gone wrong is
  // how a megabyte ends up here, and echoing it back whole helps nobody.
  err(`Unknown command: ${quoted(args.command)}\nRun 'termstash --help'.\n`);
  return 1;
}

/**
 * `termstash list | head` must not print a Node stack trace.
 *
 * Closing the read end of the pipe makes the next write fail with EPIPE, and
 * the error is emitted asynchronously on the stream — so `main`'s try/catch
 * never sees it and Node's default handler prints an unsanitised stack. That
 * was the one writer in the process that did not go through `out`/`err`.
 *
 * A reader that has stopped reading is not an error condition: `head`, `less`
 * followed by `q`, and `grep -q` all do it on purpose. Stop writing and leave
 * quietly, the way every other CLI does.
 */
function quitOnBrokenPipe(): void {
  // stdout only. Hanging this on stderr too meant a command that printed an
  // early warning to a closed stderr exited before doing its work: `search`
  // produced 285 bytes of results with a stderr reader present and nothing at
  // all without one. A reader that has stopped reading stdout is a normal
  // thing; stderr going away is not a reason to abandon the session.
  process.stderr.on("error", () => {
    // Nothing useful to do, and nowhere to say it.
  });

  for (const stream of [process.stdout]) {
    stream.on("error", (error: NodeJS.ErrnoException) => {
      // EPIPE is swallowed, not acted on. Exiting here - with any code -
      // abandoned the command mid-flight: `archive` prints a note *before* it
      // copies anything, so with a closed stdout it exited during that write
      // and no archive was ever made. Exit 0 and silence for work that never
      // happened. A reader that stopped reading is not a reason to stop
      // working; the command finishes and `main` sets the exit code it earned.
      if (error.code === "EPIPE") return;
      // Throwing from inside an 'error' listener is an uncaught exception, and
      // a raw Node stack trace is the precise outcome this function exists to
      // prevent. Say it once, in one line, and leave.
      try {
        // Through `err`, like everything else: this module exists because the
        // default handler was the one writer that bypassed the sanitiser.
        err(safe`termstash: ${error.code ?? error.message}\n`);
      } catch {
        // The stream we would report on is the one that failed.
      }
      process.exitCode = 1;
    });
  }
}

async function main(): Promise<void> {
  quitOnBrokenPipe();
  try {
    process.exitCode = await run(process.argv.slice(2));
  } catch (error) {
    const message = describeError(error);
    err(safe`termstash: ${message}\n`);
    process.exitCode = 1;
  }
}

void main();

export type { ParsedArgs };
