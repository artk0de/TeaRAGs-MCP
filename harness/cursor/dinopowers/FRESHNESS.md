# dinopowers Index Freshness Protocol

> **Resources in Cursor:** if a `tea-rags://` resource cannot be read (no
> resource tool, or the read fails), run
> `tea-rags resource "<uri>" --path "$PWD"` in the terminal — same content.

Freshness explicit + agent-driven — no background commit-reindex hook. Policy +
tree addressing owner: `tea-rags://guide/freshness` ("Addressing the Codebase").
Addressing + lag rules: core rules (always on). Wrappers follow, never restate.

## What wrappers must do

- **Address index + tree** — every read call `project=<alias>` +
  `path=<your working directory>`; linked worktree → own tree vs repo index, no
  clone, no reindex. `index_codebase`: `project` only.
- **Uncommitted / session edits** — alias's own checkout → incremental
  `index_codebase` first (`changedFiles` > 0 → NOW, no consent); linked worktree
  / subagent → never reindex (overlay serves tree; `treeState` row = pre-edit
  copy → `find_symbol`; subagent reports drift to parent). Drift `--force` → ask
  once, keep working in tea-rags.
- **Lag ≠ unusable** — never licence for Bash `cat`/`sed`/`grep`/`rg` or `Read`
  over code (→ guide/freshness "Lag never licenses leaving tea-rags").
- **No worktree clone** — overlay reads any delta; `pendingFiles` /
  `indexOnlyFiles` ≠ reindex triggers.
- **Branch finish** — `/dino-finishing-a-development-branch` reindexes `main`
  after merge + tears down any clone (`tea-rags worktree remove`). Cleanup-only
  `PostToolUse:Bash` hook = teardown backstop, never reindexes.
- **NEVER deprecated reindex endpoints** — always `index_codebase`.
- **No force-reindex** — `force_reindex` = schema drift only, explicit user
  consent.
