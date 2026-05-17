#!/usr/bin/env sh
# Auto-create .beads/redirect when a session starts inside a git worktree.
#
# Background: `git worktree add` (used by Claude Code's EnterWorktree tool and
# by hand) inherits only tracked .beads/ files. The Dolt database lives in
# .beads/dolt/<dbname>/ which is gitignored, so the worktree boots with an
# empty dolt dir and bd auto-spawns its own server pointed at nothing →
# "database not found".
#
# Fix: write absolute path to the main checkout's .beads/ into
# <worktree>/.beads/redirect. bd reads this and uses the main repo's database.
# This is exactly what `bd worktree create` does, but EnterWorktree bypasses bd.
#
# Idempotent: no-op in the main checkout and when redirect already exists.

set -e

git_dir=$(git rev-parse --git-dir 2>/dev/null) || exit 0
git_common_dir=$(git rev-parse --git-common-dir 2>/dev/null) || exit 0

[ "$git_dir" = "$git_common_dir" ] && exit 0

main_common=$(cd "$git_common_dir" && pwd)
main_root=$(dirname "$main_common")
main_beads="$main_root/.beads"

worktree_root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
wt_beads="$worktree_root/.beads"

[ -d "$main_beads" ] || exit 0
[ -d "$wt_beads" ] || exit 0
[ -f "$wt_beads/redirect" ] && exit 0

printf '%s\n' "$main_beads" > "$wt_beads/redirect"
echo "[ensure-beads-redirect] wrote $wt_beads/redirect → $main_beads" >&2
