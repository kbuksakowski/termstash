/**
 * How TermStash was started, so a command it prints can be typed back as is.
 *
 * `npx termstash last` leaves no `termstash` on PATH, so "termstash resume
 * 91bc22" printed back to that person failed with command not found - and
 * the plugin's skill, which falls back to npx when the CLI is not installed,
 * handed exactly that line to exactly the people without it. npx runs a
 * package from its own cache directory, `_npx`, which is where the script
 * being run then lives.
 */
export function invocation(script: string = process.argv[1] ?? ""): string {
  return /[\\/]_npx[\\/]/.test(script) ? "npx termstash" : "termstash";
}
