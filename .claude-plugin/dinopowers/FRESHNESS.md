# dinopowers Index Freshness Protocol

Index freshness is **explicit and agent-driven** — there is no background
commit-reindex hook. When you execute a multi-task plan inside a git worktree,
you keep the worktree's index clone fresh with visible commands. The canonical
worktree-clone lifecycle (CREATE → per-task REINDEX → TEARDOWN) lives in
`tea-rags/rules/index-freshness.md`; the plan-execution wrappers run it.

## What wrappers must do

- **Worktree multi-task plan** — `dinopowers:executing-plans` CREATEs the clone
  at the start (`tea-rags worktree create`) and REINDEXes it
  (`mcp__tea-rags__index_codebase`, incremental) after EACH task's commit, so
  the next task searches fresh code. The parent runs the reindex whether it
  executed the task inline or via a dispatched subagent.
- **Branch finish** — `dinopowers:finishing-a-development-branch` reindexes
  `main` after a merge and tears the clone down (`tea-rags worktree remove`). A
  cleanup-only `PostToolUse:Bash` hook is the teardown backstop; it never
  reindexes.
- **Searching uncommitted WIP** — if you must search code you have edited but
  not yet committed, run `index_codebase` (incremental) manually first, then
  search.
- **NEVER call deprecated reindex endpoints** — always `index_codebase`.
- **Do not force-reindex** — `force_reindex` is for schema drift only and needs
  explicit user consent.
