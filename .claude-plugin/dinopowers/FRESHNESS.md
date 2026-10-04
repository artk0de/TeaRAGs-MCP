# dinopowers Index Freshness Protocol

Index freshness is **explicit and agent-driven** — there is no background
commit-reindex hook. Policy owner: `tea-rags/rules/index-freshness.md`; tree
addressing owner: tea-rags search-cascade "Addressing the Codebase". Wrappers
follow them, never restate them.

## What wrappers must do

- **Address the tree** — every tea-rags read call passes
  `path=<your working directory>`. In a linked worktree that reads the
  worktree's own tree against the repository's index; no clone, no reindex.
- **Uncommitted / session edits** — index-freshness reindex rows: alias's own
  checkout → incremental `index_codebase` first; linked worktree → none (the
  overlay serves the tree; a `treeState` row = index's pre-edit copy → current
  code via `find_symbol`).
- **No worktree clone** — the overlay reads a delta of any size; `pendingFiles`
  / `indexOnlyFiles` on an answer are not reindex triggers (search-cascade "Read
  the `workingTree` marker").
- **Branch finish** — `dinopowers:finishing-a-development-branch` reindexes
  `main` after a merge and tears down any clone that exists
  (`tea-rags worktree remove`). A cleanup-only `PostToolUse:Bash` hook is the
  teardown backstop; it never reindexes.
- **NEVER call deprecated reindex endpoints** — always `index_codebase`.
- **Do not force-reindex** — `force_reindex` is for schema drift only and needs
  explicit user consent.
