# Index Freshness — reindex triggers

tea-rags search reads payloads written at index time. Index lags working tree →
results silently stale. Before first tea-rags search/explore of turn, check
conditions below (signals from **prime** digest layer); reindex when one fires.

| Trigger (signal in prime / session)                                                        | Action                         | User confirmation          |
| ------------------------------------------------------------------------------------------ | ------------------------------ | -------------------------- |
| Prime banner `⚠ Index is stale (last updated Nd ago)`                                      | `index_codebase` (incremental) | no — reindex silently      |
| Files created/modified this session (`Write`/`Edit`, incl. by a subagent), not yet indexed | `index_codebase` (incremental) | no — reindex silently      |
| Prime `## Schema drift` section is **not** `none` (lists new payload fields)               | `force_reindex` (full rebuild) | **YES — explicit consent** |

## Worktree-clone lifecycle (explicit, plan execution)

Executing **multi-task plan inside git worktree** (inline- OR subagent-driven):
give worktree own index clone, keep fresh with **explicit, user-visible**
commands. **No implicit commit-reindex hook** — mid-task searches fresh only if
you ran per-task REINDEX yourself. Clone throwaway; only hook is cleanup
backstop dropping its footprint.

| Phase        | When                                     | Explicit action — run it visibly                                                                 | Target                              |
| ------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------- |
| **CREATE**   | start of a multi-task plan in a worktree | `tea-rags worktree create <name> --from <src-alias> --path <abs-worktree> --no-git`              | new clone `<src>-worktree-<name>`   |
| **REINDEX**  | after EACH task's commit                 | `tea-rags index_codebase --project <src>-worktree-<name>` (incremental)                          | the clone — next task reads fresh   |
| **TEARDOWN** | branch finished (merge OR delete)        | `tea-rags worktree remove <name>` (always) + on merge `tea-rags index_codebase --project <main>` | clone footprint dropped; main fresh |
| Schema drift | running code declares new payload fields | `force_reindex`                                                                                  | — (explicit consent, unchanged)     |

- **Run each phase explicitly — agent and user SEE it.** No background hook
  reindexes after commit; skip per-task REINDEX → next task reads stale
  payloads.
- **Gate CREATE:** only for multi-task plan in worktree. Single-task plans,
  explore-only sessions, main-checkout work use main collection directly — no
  clone. Very large source index → note size, confirm before cloning.
- **Subagent-driven / bare:** PARENT orchestrating plan runs CREATE + per-task
  REINDEX — whether task ran inline or via dispatched subagent. Subagent does
  not reindex; parent owns clone lifecycle.
- **Teardown guaranteed.** `dinopowers:finishing-a-development-branch` runs
  `worktree remove` explicitly; cleanup-only `PostToolUse:Bash` hook
  (`tea-rags/scripts/cleanup-worktree-clone.sh`) is backstop — on any
  `git worktree remove` / `git branch -D` drops clones whose worktree path gone,
  even when skill bypassed. Footprint cleanup only; never reindexes.

## Why these three actions

- **Stale / new code → `index_codebase` incremental.** Only changed (+ new)
  files re-embedded — seconds, not full rebuild. Default no-confirmation path:
  stale index → wrong rankings, fix cheap, so just run it.
- **Schema drift → `force_reindex`, with consent.** Drift = running code
  declares payload fields existing index never populated. Incremental **cannot**
  fix — unchanged files keep old payload, schema-drift guard rejects incremental
  run. Only full rebuild repopulates every chunk. Full rebuild expensive
  (minutes to hours on large projects), so **never** automatic — ask first. See
  `/tea-rags:force-reindex`.

## Detecting "files edited but not indexed"

You (or subagent) ran `Write`/`Edit` this turn and NEXT step searches
_different_ question → index does not yet see edits. Run `index_codebase`
(incremental) first. Skip when: zero files edited, continuing same
implementation task without re-searching, or next step uses ripgrep only.

In worktree plan, explicit per-task REINDEX (above) keeps clone fresh between
tasks. Code edited but NOT yet committed → run `index_codebase` (incremental)
manually before searching — see `dinopowers/FRESHNESS.md`. `index_codebase` is
only incremental entrypoint — older reindex endpoints deprecated.

## Do NOT

- Downgrade to ripgrep / Grep / Read because index stale — trades away recall
  user did not agree to. Reindex, then search.
- Run `force_reindex` for stale-only or edited-only cases — incremental correct
  and far cheaper. Full rebuild reserved for schema drift.
- Run `force_reindex` without explicit user consent, ever.
