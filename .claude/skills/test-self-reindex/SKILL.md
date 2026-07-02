---
name: test-self-reindex
description:
  Index current tea-rags worktree as separate `tea-rags-worktree` project alias,
  verify end-to-end reindexing on worktree's own source. Auto-invoke when user
  asks to "test reindexing", "проверить реиндексацию", "test tea-rags
  self-reindex", "регрессия реиндексации", "test self-reindex on worktree",
  "smoke test enrichment on worktree", or any phrasing meaning "run live
  tea-rags self-test against current worktree's code". Use instead of indexing
  main `tea-rags` alias when exercising unreleased worktree code without
  disturbing main project's index.
---

# Self-Reindex Smoke Test (Worktree)

Exercise **freshly-built tea-rags MCP server** against **current worktree's own
source tree**, registered as SEPARATE project alias (`tea-rags-worktree`) so
main `tea-rags` index untouched.

Live counterpart to test suite — `npx vitest run` checks code correctness, this
skill checks end-to-end indexing + enrichment + metric-computation pipeline
works against real code exercising every walker / resolver / preset in worktree.

## When to invoke

- User says variant of "test reindexing", "проверить реиндексацию", "test
  tea-rags self-test", "smoke test the worktree", "регрессия на собственном
  коде".
- After non-trivial change to ingest pipeline, enrichment coordinator, codegraph
  provider, or marker-store — before declaring feature done.
- After bumping `.qdrant-required-version` or migrating payload schema.

## When NOT to invoke

- Change is doc-only, test-only, rule-only — no production code path shifted;
  skip.
- User debugging specific tool against MAIN `tea-rags` alias (wants their cache,
  not fresh one).
- `npm link` not pointing at current worktree (run link-flip from
  `.claude/CLAUDE.md` § "MCP Integration Testing" first; without it, exercises
  stale published code).

## Pre-flight

First verify global symlink points at worktree you're testing. If not, surface
to user and STOP — testing against stale link worse than not testing.

```bash
readlink "$(npm root -g)/tea-rags"
# Must contain the current worktree path (e.g. .claude/worktrees/<branch>).
```

Link stale or absent → ask user to run (from worktree):

```bash
npm run build && npm link
```

…then reconnect MCP servers (`/mcp` → reconnect tea-rags) and rerun this skill.

## Workflow

### Step 1 — Resolve the worktree path

cwd should already be worktree (`.claude/worktrees/<branch>` under main
tea-rags-mcp repo). User provided path → use it; else use cwd via `pwd`.
Worktree path must be **absolute**.

### Step 2 — Register + force-reindex in one CLI command

`--name tea-rags-worktree` registers worktree path under static alias then
indexes, one command. **Alias-rename semantics** apply: name already points at
stale (deleted) path → register RE-POINTS existing entry at new worktree path —
physical Qdrant collection, snapshot file, codegraph DB stay intact (no data
dropped, no forced reindex from rename alone). `--force` rebuilds index from
scratch; `--wait-enrichments` stays attached until every enrichment provider
finishes; `--json` emits parseable result.

```bash
tea-rags index-codebase <absolute-worktree-path> --name tea-rags-worktree --force --wait-enrichments --json
```

Rebuilds from scratch — exercises chunker, all extraction walkers (TS / JS /
Python / Ruby / Go / Java / Rust / Bash), all symbol-table inserts, graph
adapter, Tarjan SCC, PageRank, payload writers, enrichment coordinator
(markStart → file-phase → chunk-phase → markFileFinal / markChunkFinal).
`--wait-enrichments` blocks until completion → command returns only after
enrichment settles, no log polling. (Bound with hard ~5-minute wall-clock limit
via Bash `timeout` param so hung enrichment doesn't lock session.)

**`index-codebase --name` vs `tea-rags worktree create`.** This skill uses
`index-codebase --name` — FULL `--force` rebuild re-exercising whole pipeline
(the point of smoke test). NOT same as `tea-rags worktree create`, which CLONES
existing index for plan-execution freshness (fast, no pipeline run — see
`tea-rags/rules/index-freshness.md`). If you reach for `worktree create`
instead, its source resolves via `registry.findByPath(cwd)`: run from registered
project root OR pass `--from <alias>`; give `--path <abs-worktree>` and
`--no-git` to attach to existing worktree dir.

### Step 3 — Verify all four enrichment levels reach `healthy`

```
mcp__tea-rags__get_index_status project: "tea-rags-worktree"
```

Expected:

- `enrichment.git.file.status === "healthy"`
- `enrichment.git.chunk.status === "healthy"`
- `enrichment.codegraph.symbols.file.status === "healthy"`
- `enrichment.codegraph.symbols.chunk.status === "healthy"`

Anything else — `in_progress`, `failed`, `degraded` — is regression. Surface raw
payload of metadata point for diagnosis:

```bash
# UUID = sha256("__indexing_metadata__") trimmed to UUID format
curl -s "<qdrant-url>/collections/<collection>/points/<uuid>" | jq .
```

### Step 4 — Functional smoke tests against the new alias

Run short battery confirming codegraph + composite-preset path works end-to-end
on freshly indexed alias. Each call should succeed, return non-empty results.

| Call                                                                                                   | Validates                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mcp__tea-rags__find_cycles project: "tea-rags-worktree" scope: "file"`                                | Tarjan SCC over file edges; produces real cycles for tea-rags-mcp (contracts triangle, git metrics pair)                                                                                                                                     |
| `mcp__tea-rags__find_cycles project: "tea-rags-worktree" scope: "method"`                              | Method-graph SCC path                                                                                                                                                                                                                        |
| `mcp__tea-rags__get_callers symbolId: "EnrichmentCoordinator#awaitCompletion"` (any well-known symbol) | Symbol-table → adapter retrieval. Use `#` for instance methods per `.claude/rules/symbolid-convention.md`; `.` is for static / classmethod. A `.` form here returns empty results silently — that's a convention mismatch, NOT a regression. |
| `mcp__tea-rags__semantic_search query: "configuration parsing" rerank: "architecturalHub"`             | Composite preset override resolves; rerank attaches overlay                                                                                                                                                                                  |
| `mcp__tea-rags__semantic_search query: "trajectory registry" rerank: "blastRadius"`                    | Composite preset uses `codegraph.file.fanOut`/`transitiveImpact` correctly                                                                                                                                                                   |

Any tool returning InputValidationError, empty result, or stack trace is
regression — surface raw error to user before claiming success.

### Step 5 — Report

Summarize outcome in compact table. Show:

- alias / collection / chunk count (from `get_index_status`)
- enrichment durations per provider per level
- functional check pass/fail
- any markers stuck on `in_progress` or `failed`

Everything green → end with one-line `result:` declaring smoke passed. Anything
failed → write `needs input:` describing what broke so user decides fix-forward
or revert.

## Anti-patterns

- **Testing against the main `tea-rags` alias.** That alias = user's working
  index; reindexing disrupts search history and stats. Always use SEPARATE alias
  (`tea-rags-worktree`) for self-tests.
- **Skipping the link verification.** `npm root -g`/tea-rags doesn't point at
  this worktree → MCP server runs PUBLISHED code, test validates nothing about
  local changes.
- **Re-introducing a manual enrichment-wait loop.** `--wait-enrichments` already
  blocks until every provider finishes → Step 2 command returns only after
  enrichment settles — do not poll `get_index_status` or pipeline log to wait.
- **Declaring success while file-level enrichment is `in_progress`.** User cares
  about end-state health, not intermediate. `--wait-enrichments` returns
  settled; Step 3 health check is gate — re-check status if anything reads
  non-`healthy`.
- **Mutating the worktree source between Step 2 and Step 4.** Invalidates index
  you just built. Need to edit source → re-run from Step 2.
- **`tea-rags worktree create` from an unregistered cwd.** Resolves source
  project via `registry.findByPath(cwd)`; cwd outside any registered project
  fails with `Source project not found (from=cwd)`. Pass `--from <alias>` (with
  `--path <abs>` and `--no-git`), or run from registered project root.
