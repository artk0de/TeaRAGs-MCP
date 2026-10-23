#!/usr/bin/env bash
# SessionStart: hooks follow the repo HEAD, the CLI follows the last build. A dev
# install (global link → repo) with a stale build/ drifts silently from the
# hooks that call it. Warn once; never fail the session.
ROOT="${TEA_RAGS_PACKAGE_ROOT:-}"
if [ -z "$ROOT" ]; then
  BIN="$(command -v tea-rags 2>/dev/null)" || exit 0
  REAL="$(node -e 'console.log(require("fs").realpathSync(process.argv[1]))' "$BIN" 2>/dev/null)" || exit 0
  ROOT="$(cd "$(dirname "$REAL")/.." 2>/dev/null && pwd)" || exit 0
fi
[ -d "$ROOT/.git" ] || [ -f "$ROOT/.git" ] || exit 0
[ -f "$ROOT/build/index.js" ] || exit 0
SRC_TS="$(git -C "$ROOT" log -1 --format=%ct -- src 2>/dev/null)"; [ -n "$SRC_TS" ] || exit 0
BUILD_TS="$(stat -f %m "$ROOT/build/index.js" 2>/dev/null || stat -c %Y "$ROOT/build/index.js" 2>/dev/null)" || exit 0
if [ "$SRC_TS" -gt "$BUILD_TS" ]; then
  iso() { date -r "$1" -u +%FT%TZ 2>/dev/null || date -d "@$1" -u +%FT%TZ; }
  echo "⚠ tea-rags build is older than its source (build $(iso "$BUILD_TS"), last src commit $(iso "$SRC_TS")) — run \`npm run build\` in $ROOT"
fi
exit 0
