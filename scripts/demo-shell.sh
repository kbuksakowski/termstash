#!/usr/bin/env bash
# Open a shell pointed at a synthetic Claude storage tree, for recording demos.
#
#   ./scripts/demo-shell.sh
#
# Inside that shell, `termstash` sees six invented sessions instead of your real
# ones. Nothing it can display comes from your machine, so a recording cannot
# leak a client name, a path or a prompt. Type `exit` to leave.
set -euo pipefail

cd "$(dirname "$0")/.."
DEMO=/tmp/termstash-demo

npm run build >/dev/null
rm -rf "$DEMO"
node scripts/demo-env.mjs "$DEMO/claude" >/dev/null
mkdir -p "$DEMO/ts" "$DEMO/bin"

# npm does not link a package's own bin into its node_modules/.bin, so a shim is
# the only way `termstash` in this shell means the build that just ran rather
# than a global install from somewhere else.
cat > "$DEMO/bin/termstash" <<INNER
#!/bin/bash
exec node "$PWD/dist/cli.js" "\$@"
INNER
chmod +x "$DEMO/bin/termstash"

export CLAUDE_CONFIG_DIR="$DEMO/claude"
export TERMSTASH_HOME="$DEMO/ts"
export PATH="$DEMO/bin:$PATH"

cat <<'BANNER'

  Demo shell — termstash now sees six invented sessions, not yours.

  Suggested takes:

    termstash list
    termstash list --at-risk
    termstash search stripe
    termstash pin 7f31a2
    termstash list --pinned

  Full loop (the strongest one):

    termstash pin d5e5f2
    rm /tmp/termstash-demo/claude/projects/-Users-you-work-billing-service/d5e5f2*.jsonl
    termstash list                  # gone
    termstash restore d5e5f2
    termstash list                  # back

  Type `exit` to leave.

BANNER

# An interactive shell sources the user's rc file, which will overwrite any
# prompt set here — so the sandbox is announced in the banner above rather than
# promised in the prompt. Bash is the fallback because it is the one shell
# present on every platform this project claims to support.
exec "${SHELL:-/bin/bash}"
