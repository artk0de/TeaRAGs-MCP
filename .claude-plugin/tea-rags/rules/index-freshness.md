# Index Freshness — reindex triggers

tea-rags search reads payloads written at index time. Index lags working tree →
results silently stale. Before first tea-rags search/explore of turn, check
conditions below (signals from **prime** digest layer); reindex when one fires.

| Trigger (signal in prime / session)                                                        | Action                                                          | User confirmation          |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------- | -------------------------- |
| Prime banner `⚠ Index is stale (last updated Nd ago)`                                      | `index_codebase` (incremental)                                  | no — reindex silently      |
| Files created/modified this session (`Write`/`Edit`, incl. by a subagent), not yet indexed | `index_codebase` (incremental)                                  | no — reindex silently      |
| Prime `## Drift` whose `Run:` line is the plain incremental (no flag)                      | `tea-rags index-codebase --project <alias>` — exactly that line | no — reindex silently      |
| Prime `## Drift` whose `Run:` line carries `--force-enrichments` or `--force`              | the `Run:` command the section names                            | **YES — explicit consent** |

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
| Drift        | prime / status `## Drift` is not `none`  | the ONE `Run:` line that report ends with                                                        | — (consent per the table above)     |

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
- **Drift → the command the report names; consent depends on which one.** Drift
  = a stamp the index carries (payload keys, language versions, indexing env,
  indexed commit) no longer matches what the running build would produce. When
  the ONLY thing that moved is the working tree, the `Run:` line is the plain
  incremental — the same command and the same cost as the stale banner, so it
  runs without asking. Otherwise an incremental run neither refuses nor fixes
  it: unchanged files keep their old payload, so the report persists until the
  ONE `Run:` line it ends with has run —
  `tea-rags index-codebase --force-enrichments <trajectory>` when every new key
  is enrichment-owned (`git.*`, `codegraph.*`), `--force` when a chunker-owned
  key moved. Both rewrite shared state and `--force` is minutes to hours on a
  large project, so **never** run either automatically — ask first. See
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
  and far cheaper. Full rebuild reserved for the drift reports whose `Run:` line
  actually says `--force`; enrichment-owned drift is repaired by
  `--force-enrichments <scope>` in minutes.
- Run `force_reindex` without explicit user consent, ever.
