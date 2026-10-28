# dinopowers Index Freshness Protocol

Freshness explicit + agent-driven — no background commit-reindex hook. Policy +
tree addressing owner: `tea-rags://guide/freshness` ("Addressing the Codebase").
Addressing + lag rules: core rules (always on). Wrappers follow, never restate.

## What wrappers must do

- **Address index + tree** — every read call `project=<alias>` +
  `path=<your working directory>`; linked worktree → own tree vs repo index, no
  clone, no reindex. `index_codebase`: `project` only.
- **Index behind** (uncommitted / session edits, HEAD moved, any
  `changedFiles` > 0), first match: subagent → never reindex, never ask; the
  answer prints the report line
  `to parent: index behind (changedFiles <N>) — run <Run: line>` (no drift → no
  `run` part); linked worktree → never reindex (overlay serves tree; `treeState`
  row = pre-edit copy → `find_symbol`; `pendingFiles` > 0 (a count; your file
  may be one) → plan both lines: `find_symbol(<same params>)` and
  `still in pendingFiles → find_symbol(<same params>) again`); main session in
  the alias's own checkout → incremental `index_codebase(project=)` NOW, no
  consent. Drift `Run:` with `--force` adds ONE line ask the user: run <Run:
  line>? — --force not run; reads continue meanwhile` beside that incremental
  call — never instead of it, never "won't proceed".
- **Lag ≠ unusable** — never licence for Bash `cat`/`sed`/`head` or shell sed -n
  '<start>,<end>p' <one file> over code (→ guide/freshness "Lag never licenses
  leaving tea-rags").
- **No worktree clone** — overlay reads any delta; `pendingFiles` /
  `indexOnlyFiles` ≠ reindex triggers.
- **Branch finish** — `$dino-finishing-a-development-branch` reindexes `main`
  after merge + tears down any clone (`tea-rags worktree remove`). Cleanup-only
  `PostToolUse:Bash` hook = teardown backstop, never reindexes.
- **NEVER deprecated reindex endpoints** — always `index_codebase`.
- **No force-reindex** — `force_reindex` = schema drift only, explicit user
  consent.
