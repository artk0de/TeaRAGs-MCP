# dinopowers Index Freshness Protocol

Index freshness is **explicit and agent-driven** — there is no background
commit-reindex hook. Policy owner: `tea-rags://guide/freshness`; tree addressing
owner: tea-rags `tea-rags://guide/freshness` "Addressing the Codebase". Wrappers
follow them, never restate them.

## What wrappers must do

- **Address index + tree** — every tea-rags read call passes `project=<alias>`
  (which index) + `path=<your working directory>` (which tree). In a linked
  worktree that reads the worktree's own tree against the repository's index; no
  clone, no reindex. `index_codebase`: `project` only.
- **Uncommitted / session edits** — `tea-rags://guide/freshness` reindex rows:
  alias's own checkout → incremental `index_codebase` first; linked worktree →
  none (the overlay serves the tree; a `treeState` row = index's pre-edit copy →
  current code via `find_symbol`).
- **Lag ≠ unusable** — `changedFiles` / `pendingFiles` / `floors: []` / drift =
  distance index↔tree, never licence for Bash `cat` / `sed` / `grep` / `rg` or
  `Read` over code (thousands of changed files included). Row without
  `treeState` = current → use it; `treeState` row → `find_symbol` (re-call). Own
  checkout with `changedFiles` > 0 → incremental `index_codebase` NOW, no
  consent; drift `--force` → ask once, keep working in tea-rags. Linked worktree
  / subagent → never reindex, re-call (subagent reports drift to parent). Owner:
  `tea-rags://guide/freshness` "Lag never licenses leaving tea-rags".
- **No worktree clone** — the overlay reads a delta of any size; `pendingFiles`
  / `indexOnlyFiles` on an answer are not reindex triggers
  (`tea-rags://guide/freshness` "Read the `workingTree` marker").
- **Branch finish** — `dinopowers:finishing-a-development-branch` reindexes
  `main` after a merge and tears down any clone that exists
  (`tea-rags worktree remove`). A cleanup-only `PostToolUse:Bash` hook is the
  teardown backstop; it never reindexes.
- **NEVER call deprecated reindex endpoints** — always `index_codebase`.
- **Do not force-reindex** — `force_reindex` is for schema drift only and needs
  explicit user consent.
