# Index Freshness — reindex triggers

tea-rags search reads payloads written at index time. If the index lags the
working tree, results are silently stale. Before the first tea-rags
search/explore of a turn, check the conditions below (signals come from the
**prime** digest layer) and reindex when one fires.

| Trigger (signal in prime / session)                                                        | Action                         | User confirmation          |
| ------------------------------------------------------------------------------------------ | ------------------------------ | -------------------------- |
| Prime banner `⚠ Index is stale (last updated Nd ago)`                                      | `index_codebase` (incremental) | no — reindex silently      |
| Files created/modified this session (`Write`/`Edit`, incl. by a subagent), not yet indexed | `index_codebase` (incremental) | no — reindex silently      |
| Prime `## Schema drift` section is **not** `none` (lists new payload fields)               | `force_reindex` (full rebuild) | **YES — explicit consent** |

## Worktree-clone lifecycle (explicit, plan execution)

When you execute a **multi-task plan inside a git worktree** (inline-driven OR
subagent-driven), give the worktree its own index clone and keep it fresh with
**explicit, user-visible** commands. There is **no implicit commit-reindex
hook** — mid-task searches are fresh only if you ran the per-task REINDEX
yourself. The clone is throwaway; the only hook is a cleanup backstop that drops
its footprint.

| Phase        | When                                     | Explicit action — run it visibly                                                                 | Target                              |
| ------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------- |
| **CREATE**   | start of a multi-task plan in a worktree | `tea-rags worktree create <name> --from <src-alias> --path <abs-worktree> --no-git`              | new clone `<src>-worktree-<name>`   |
| **REINDEX**  | after EACH task's commit                 | `tea-rags index_codebase --project <src>-worktree-<name>` (incremental)                          | the clone — next task reads fresh   |
| **TEARDOWN** | branch finished (merge OR delete)        | `tea-rags worktree remove <name>` (always) + on merge `tea-rags index_codebase --project <main>` | clone footprint dropped; main fresh |
| Schema drift | running code declares new payload fields | `force_reindex`                                                                                  | — (explicit consent, unchanged)     |

- **Run each phase explicitly — the agent and the user SEE it.** No background
  hook reindexes after a commit; if you skip the per-task REINDEX, the next
  task's searches read stale payloads.
- **Gate CREATE:** only for a multi-task plan in a worktree. Single-task plans,
  explore-only sessions, and main-checkout work use the main collection directly
  — no clone. For a very large source index, note the size and confirm before
  cloning.
- **Subagent-driven / bare:** the PARENT orchestrating the plan runs CREATE and
  the per-task REINDEX — whether it executed the task inline or via a dispatched
  subagent. The subagent does not reindex; the parent owns the clone lifecycle.
- **Teardown is guaranteed.** `dinopowers:finishing-a-development-branch` runs
  `worktree remove` explicitly; a cleanup-only `PostToolUse:Bash` hook
  (`tea-rags/scripts/cleanup-worktree-clone.sh`) is the backstop — on any
  `git worktree remove` / `git branch -D` it drops clones whose worktree path is
  gone, even when the skill is bypassed. It is footprint cleanup only; it never
  reindexes.

## Why these three actions

- **Stale / new code → `index_codebase` incremental.** Only changed (and new)
  files are re-embedded — seconds, not a full rebuild. This is the default,
  no-confirmation path: a stale index produces wrong rankings, and the fix is
  cheap, so just run it.
- **Schema drift → `force_reindex`, with consent.** Drift means the running code
  declares payload fields the existing index never populated. Incremental
  reindex **cannot** fix this — unchanged files keep their old payload, and the
  schema-drift guard rejects an incremental run. Only a full rebuild repopulates
  every chunk. A full rebuild is expensive (minutes to hours on large projects),
  so it is **never** automatic — ask first. See `/tea-rags:force-reindex`.

## Detecting "files edited but not indexed"

If you (or a subagent) ran `Write`/`Edit` this turn and the NEXT step searches
for a _different_ question, the index does not yet see those edits. Run
`index_codebase` (incremental) first. Skip when: zero files were edited, you are
continuing the same implementation task without re-searching, or the next step
uses ripgrep only.

In a worktree plan, the explicit per-task REINDEX (above) keeps the clone fresh
between tasks. For code you have edited but NOT yet committed, run
`index_codebase` (incremental) manually before searching — see
`dinopowers/FRESHNESS.md`. `index_codebase` is the only incremental entrypoint —
older reindex endpoints are deprecated.

## Do NOT

- Downgrade to ripgrep / Grep / Read because the index is stale — that trades
  away recall the user did not agree to. Reindex, then search.
- Run `force_reindex` for stale-only or edited-only cases — incremental is
  correct and far cheaper. Full rebuild is reserved for schema drift.
- Run `force_reindex` without explicit user consent, ever.
