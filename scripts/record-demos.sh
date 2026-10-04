#!/usr/bin/env bash
# Regenerate the README recordings.
#
#   ./scripts/record-demos.sh
#
# Records against a synthetic storage tree built by demo-env.mjs - never a real
# ~/.claude, whose transcripts hold real project names, paths and prompt text.
# A GIF in a public README cannot be un-published.
#
# Requires: asciinema, agg  (brew install asciinema agg)
set -euo pipefail

cd "$(dirname "$0")/.."
DEMO=/tmp/termstash-demo
OUT=.github/assets

command -v asciinema >/dev/null || { echo "asciinema not found: brew install asciinema"; exit 1; }
command -v agg >/dev/null || { echo "agg not found: brew install agg"; exit 1; }

npm run build >/dev/null
rm -rf "$DEMO"
node scripts/demo-env.mjs "$DEMO/claude" >/dev/null
mkdir -p "$DEMO/ts" "$DEMO/bin" "$DEMO/gif" "$OUT"

# Record the CLI just built, not whatever `termstash` happens to resolve to. A
# global install from another checkout would otherwise be recorded silently.
cat > "$DEMO/bin/termstash" <<INNER
#!/bin/bash
exec node "$PWD/dist/cli.js" "\$@"
INNER
chmod +x "$DEMO/bin/termstash"

# Pin what demo-env.mjs marked as pinned, through the real command, so the star
# in the recording stands on an archive that was actually written and verified.
while read -r id; do
  [ -n "$id" ] || continue
  CLAUDE_CONFIG_DIR="$DEMO/claude" TERMSTASH_HOME="$DEMO/ts" "$DEMO/bin/termstash" pin "$id" >/dev/null
done < "$DEMO/claude/.termstash-demo-pins"

cat > "$DEMO/list.sh" <<'INNER'
#!/bin/bash
export CLAUDE_CONFIG_DIR=/tmp/termstash-demo/claude TERMSTASH_HOME=/tmp/termstash-demo/ts
export PATH=/tmp/termstash-demo/bin:$PATH
type_out() { printf '\033[1;32m$\033[0m '; for ((i=0;i<${#1};i++)); do printf '%s' "${1:$i:1}"; sleep 0.045; done; printf '\n'; sleep 0.35; }
clear
type_out "termstash list"; termstash list; sleep 3.5
type_out "termstash list --at-risk"; termstash list --at-risk; sleep 3.5
INNER

cat > "$DEMO/search.sh" <<'INNER'
#!/bin/bash
export CLAUDE_CONFIG_DIR=/tmp/termstash-demo/claude TERMSTASH_HOME=/tmp/termstash-demo/ts
export PATH=/tmp/termstash-demo/bin:$PATH
type_out() { printf '\033[1;32m$\033[0m '; for ((i=0;i<${#1};i++)); do printf '%s' "${1:$i:1}"; sleep 0.045; done; printf '\n'; sleep 0.35; }
clear
type_out "termstash search stripe"; termstash search stripe; sleep 5
INNER

cat > "$DEMO/restore.sh" <<'INNER'
#!/bin/bash
export CLAUDE_CONFIG_DIR=/tmp/termstash-demo/claude TERMSTASH_HOME=/tmp/termstash-demo/ts
export PATH=/tmp/termstash-demo/bin:$PATH
type_out() { printf '\033[1;32m$\033[0m '; for ((i=0;i<${#1};i++)); do printf '%s' "${1:$i:1}"; sleep 0.045; done; printf '\n'; sleep 0.35; }
clear
type_out "termstash pin aa71f9"; termstash pin aa71f9; sleep 1.5
# Exactly what Claude's sweep does a month later, and the reason the pin above
# is the whole product. The session is deliberately the only one in its
# project, so the list below is about it and nothing else.
type_out "rm \$CLAUDE_CONFIG_DIR/projects/-Users-you-work-web-client/aa71f903-*.jsonl"
rm "$CLAUDE_CONFIG_DIR"/projects/-Users-you-work-web-client/aa71f903-*.jsonl
sleep 0.8
type_out "termstash list --project web-client"; termstash list --project web-client; sleep 3.5
type_out "termstash restore aa71f9"; termstash restore aa71f9; sleep 5
INNER

chmod +x "$DEMO"/*.sh

# asciinema 3 renamed the size flags. Passing the old ones is not an error, it
# is silently ignored - so every recording was made at the terminal's own 80x24
# while the script asked for 96 columns, and the `list` footer wrapped
# mid-sentence in the README's first image. Choose the flag this build has, and
# then check the recording actually has the size that was asked for.
if asciinema rec --help 2>&1 | grep -q -- '--window-size'; then
  size_args() { printf -- '--window-size\n%sx%s\n' "$1" "$2"; }
else
  size_args() { printf -- '--cols\n%s\n--rows\n%s\n' "$1" "$2"; }
fi

record() { # name cols rows script
  local args=()
  while IFS= read -r a; do args+=("$a"); done < <(size_args "$2" "$3")
  asciinema rec "${args[@]}" --overwrite --command "$4" "$DEMO/$1.cast" >/dev/null 2>&1

  # The recorded size is in the cast header. A mismatch means the flag was
  # ignored again, and the gif would be wrong in a way only a human rereading
  # the README would catch.
  local got
  got=$(head -1 "$DEMO/$1.cast" | sed -n 's/.*"cols":\([0-9]*\).*"rows":\([0-9]*\).*/\1x\2/p')
  if [ "$got" != "$2x$3" ]; then
    echo "REFUSING: asked asciinema for $2x$3 and the recording is $got." >&2
    echo "The size flag was ignored. Nothing was copied into $OUT." >&2
    exit 1
  fi

  agg --theme asciinema --font-size 18 --idle-time-limit 2 "$DEMO/$1.cast" "$DEMO/gif/$1.gif" >/dev/null 2>&1
  printf '  %-12s %sx%s  %s KB\n' "$1.gif" "$2" "$3" "$(( $(stat -f %z "$DEMO/gif/$1.gif" 2>/dev/null || stat -c %s "$DEMO/gif/$1.gif") / 1024 ))"
}

echo "recording:"
record list 96 23 "$DEMO/list.sh"
record search 96 20 "$DEMO/search.sh"
# Last, because it pins a session and deletes a transcript: anything recorded
# after it would be showing a different machine than the two above.
record restore 96 24 "$DEMO/restore.sh"

# The recordings must never contain anything from the real machine. Checked
# structurally rather than against a list of names: a deny-list in a public
# repository would itself publish the names it is meant to keep out. Everything
# the demo produces lives under /Users/you or /tmp/termstash-demo, so any other
# home directory is a leak.
#
# Both spellings are checked. Claude names a project directory by replacing
# every non-alphanumeric with a dash, so a real home path reaches a transcript
# as `-Users-someone-...` and the slash form alone would never see it.
leak=$(grep -ohE '/(Users|home)/[A-Za-z0-9._-]+|-(Users|home)-[A-Za-z0-9]+' "$DEMO"/*.cast 2>/dev/null |
  sort -u | grep -vE '^/Users/you$|^-Users-you$' || true)
if [ -n "$leak" ]; then
  echo "REFUSING: a recording contains a real home directory:" >&2
  echo "$leak" >&2
  echo "Nothing was copied into $OUT." >&2
  exit 1
fi

# Only now does anything reach the directory that gets committed.
mv "$DEMO/gif"/*.gif "$OUT/"
echo "clean"
