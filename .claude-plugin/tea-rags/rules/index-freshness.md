# Index Freshness — reindex triggers

tea-rags search reads payloads written at index time. Index lags working tree →
results silently stale. Before first tea-rags search/explore of turn, check
conditions below (signals from **prime** digest layer); reindex when one fires.

| Trigger (signal in prime / session)                                                                                                      | Action                                                                                                                                                                                                                                             | User confirmation          |
| ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| Prime banner `⚠ Index is stale (last updated Nd ago)`                                                                                    | `index_codebase` (incremental)                                                                                                                                                                                                                     | no — reindex silently      |
| Files created/modified this session (`Write`/`Edit`, incl. by a subagent — parent reindexes), not yet indexed — **alias's own checkout** | `index_codebase` (incremental)                                                                                                                                                                                                                     | no — reindex silently      |
| Uncommitted edits the index has not seen (`git status` lists paths), before searching them — **alias's own checkout**                    | `index_codebase` (incremental)                                                                                                                                                                                                                     | no — reindex silently      |
| Same two rows in a **linked worktree** (your working directory is not the alias's checkout path — `list_projects` / prime `## Project`)  | **none** — read tools overlay the tree (`path=<your working directory>`); never reindex for the tree's own edits                                                                                                                                   | —                          |
| Prime `## Drift` whose `Run:` line is the plain incremental (no flag)                                                                    | `tea-rags index-codebase --project <alias>` — exactly that line                                                                                                                                                                                    | no — reindex silently      |
| Prime `## Drift` whose `Run:` line carries `--force-enrichments` or `--force`                                                            | the `Run:` command the section names                                                                                                                                                                                                               | **YES — explicit consent** |
| Prime `## Drift` seen from a **linked worktree**                                                                                         | Drift compares the shared INDEX with the alias's own checkout and the running build — never your tree (your delta = `workingTree.changedFiles`). Run the `Run:` line exactly as printed (`--project <alias>`), never re-aimed at `path=<worktree>` | per the two rows above     |

## Linked worktree — overlay, not reindex

Read tools answer for the tree at `path=<your working directory>` against the
repository's index — floors and `treeState` reading: search-cascade "Addressing
the Codebase". Main-checkout reindex cannot see worktree edits;
`index_codebase path=<worktree>` seeds a separate project. Both wrong → never
reindex for the tree's own edits — `pendingFiles` (not yet warm, a later call
reads more) and `indexOnlyFiles` (no AST chunking, served from the index)
included. `degraded` → its `remedy` under the consent rows above. Main checkout
keeps the reindex rows above: dense vectors of changed files lag otherwise.

## Worktree clone — teardown only

No overlay answer calls for a per-worktree index clone: the overlay reads a
delta of any size. A clone that exists (`tea-rags worktree create`, run by hand)
is torn down when its branch finishes —
`dinopowers:finishing-a-development-branch` runs
`tea-rags worktree remove <name>`; cleanup-only `PostToolUse:Bash` hook
(`tea-rags/scripts/cleanup-worktree-clone.sh`) is backstop on any
`git worktree remove` / `git branch -D`. Footprint cleanup only; never
reindexes.

## Why these three actions

- **Stale / new code → `index_codebase` incremental.** Only changed (+ new)
  files re-embedded — seconds, not full rebuild. Default no-confirmation path:
  stale index → wrong rankings, fix cheap, so just run it.
- **Drift → the command the report names; consent depends on which one.** Drift
  = a stamp the index carries (payload keys, language versions, indexing env,
  indexed commit) no longer matches what the running build would produce. When
  the ONLY thing that moved is the alias checkout's HEAD, the `Run:` line is the
  plain incremental — the same command and the same cost as the stale banner, so
  it runs without asking. Otherwise an incremental run neither refuses nor fixes
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
implementation task without re-searching, or next step uses ripgrep only. Edits
made outside this session count the same: `git status --porcelain -uall` listing
paths you are about to search fires the uncommitted-edits row. Prime staleness
is time-based and never sees them.

Applies to the alias's own checkout. Linked worktree → no reindex (overlay,
above). `index_codebase` is only incremental entrypoint — older reindex
endpoints deprecated.

## Do NOT

- Downgrade to ripgrep / Grep / Read because index stale — trades away recall
  user did not agree to. Reindex, then search.
- Run `force_reindex` for stale-only or edited-only cases — incremental correct
  and far cheaper. Full rebuild reserved for the drift reports whose `Run:` line
  actually says `--force`; enrichment-owned drift is repaired by
  `--force-enrichments <scope>` in minutes.
- Run `force_reindex` without explicit user consent, ever.
