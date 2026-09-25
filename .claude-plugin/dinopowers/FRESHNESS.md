# dinopowers Index Freshness Protocol

Index freshness is **explicit and agent-driven** — there is no background
commit-reindex hook. When you execute a multi-task plan inside a git worktree,
you keep the worktree's index clone fresh with visible commands. The canonical
worktree-clone lifecycle (read-side PRECONDITION → TEARDOWN) lives in
`tea-rags/rules/index-freshness.md`; the plan-execution wrappers run it.

## What wrappers must do

- **Worktree multi-task plan** — `dinopowers:executing-plans` Step 2.0 runs
  BEFORE each task's first tea-rags call (the pre-touch guard): ensure the clone
  exists (`tea-rags worktree info --json`; lazy `tea-rags worktree create` when
  absent), then incremental `mcp__tea-rags__index_codebase` on it, then the
  guard reads that clone. Freshness is checked where staleness bites — at the
  read — not remembered after a commit. The parent runs it whether the task
  executes inline or via a dispatched subagent.
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
