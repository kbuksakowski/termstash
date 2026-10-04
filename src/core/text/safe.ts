/**
 * Text safety, below the rendering layer.
 *
 * These lived in the CLI's formatter, which meant the core could not compose a
 * message safely without importing upward. The core does compose messages —
 * `restoreArchive` builds its refusal reasons out of filesystem paths, and a
 * path component is a readdir name, which can contain a newline. That one
 * unreachable primitive was the last way to print a forged
 * "✓ Session restored and verified" block inside a failure message.
 */

/**
 * Strip anything that lets text act on the terminal instead of being read by it.
 *
 * Almost everything this tool prints is other people's writing: session titles,
 * prompts, transcript snippets. A transcript holds whatever Claude ever read —
 * a file, command output, a fetched page — so hostile bytes do not require a
 * hostile user, only a curious one. Printed raw, an escape sequence can rewrite
 * the line it sits on (so a swept session displays as safe), retitle the window,
 * or on terminals that honour OSC 52 write to the clipboard.
 *
 * Bidi overrides go too: they reorder rendering without changing the bytes,
 * which is the Trojan Source trick and would let a title read as another one.
 *
 * Replaced rather than deleted, because a title that silently loses characters
 * is its own small lie.
 */
export function safeText(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const control = code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f);
    const separator = code === 0x2028 || code === 0x2029;
    // Explicit overrides and isolates, plus the implicit marks: LRM, RLM and
    // ALM reorder neutral characters without an override in sight, so leaving
    // them closed only half of Trojan Source.
    const bidi =
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069) ||
      code === 0x200e ||
      code === 0x200f ||
      code === 0x061c;
    // Interlinear annotation: terminals that honour it hide text inside it.
    const annotation = code >= 0xfff9 && code <= 0xfffb;
    // Everything else that paints nothing.
    //
    // The bidi set was complete and the rest of the default-ignorable class
    // was not, which is the half that hides text rather than reordering it.
    // Demonstrated: two `list` rows that paint identically to the eye, the
    // second carrying nineteen invisible code points that decode to a shell
    // command and land on the clipboard when the row is copied.
    //
    // ZWNJ and ZWJ are deliberately kept. Persian and Hindi need U+200C and
    // emoji families need U+200D; replacing them would corrupt real titles to
    // close an attack the ID column already distinguishes.
    const invisible =
      code === 0x00ad ||
      code === 0x061c ||
      code === 0x180e ||
      code === 0x200b ||
      (code >= 0x2060 && code <= 0x2064) ||
      (code >= 0x206a && code <= 0x206f) ||
      code === 0x3164 ||
      code === 0xfeff ||
      code === 0xffa0 ||
      code === 0x110bd ||
      code === 0x110cd ||
      (code >= 0x13430 && code <= 0x1343f) ||
      (code >= 0x1bca0 && code <= 0x1bca3) ||
      (code >= 0x1d173 && code <= 0x1d17a) ||
      (code >= 0xe0000 && code <= 0xe007f); // tag characters
    out += control || separator || bidi || annotation || invisible ? "\ufffd" : char;
  }
  return out;
}

/**
 * `safeText`, with the two characters this tool's own layout is made of.
 *
 * Newline and tab are the only control characters TermStash writes on purpose,
 * so they are the only ones that survive. Everything else is neutralised the
 * same way and for the same reason.
 */
export function safeBlock(text: string): string {
  let out = "";
  for (const char of text) {
    out += char === "\n" || char === "\t" ? char : safeText(char);
  }
  return out;
}

/**
 * Compose a message whose literal parts are ours and whose values are not.
 *
 * `safeBlock` keeps newline and tab because this tool's own layout is made of
 * them, and that left the door open one level up: a message built as
 * `` `...${path}...` `` hands the writer a string in which the attacker's
 * newlines are indistinguishable from ours. A transcript whose `cwd` contained
 * a newline printed a forged "✓ Session restored and verified" block, with a
 * path under the reader's real Claude directory, inside a failure message.
 *
 * A tagged template is the one construct that can tell the two apart: the
 * literal spans are written here, the substitutions came from somewhere else.
 * Only the substitutions are sanitised, so our layout survives and a value can
 * never add a line.
 *
 * Use it for every message that interpolates anything read from a transcript,
 * a manifest, an argument or an errno. `safeText` on a number or a short id
 * costs nothing, so the rule needs no judgement: if it is a `${}`, it goes
 * through here.
 */
export function safe(parts: TemplateStringsArray, ...values: unknown[]): string {
  let composed = "";
  parts.forEach((part, index) => {
    composed += part;
    if (index < values.length) composed += safeText(String(values[index]));
  });
  return composed;
}

/**
 * Turn a thrown value into text a human can read, safely.
 *
 * An errno message always carries a path, and a path component is a directory
 * name, which may contain a newline or a tab. Nine places turned errors into
 * strings and each one was a chance to forget — one of them was still forging
 * lines inside a `restore` failure after two rounds of fixing exactly that,
 * next to a comment claiming both directions were right.
 *
 * Sanitising where the text is made, rather than where it is printed, is the
 * only version of this that does not depend on the next author remembering.
 */
export function describeError(error: unknown): string {
  return safeText(error instanceof Error ? error.message : String(error));
}
