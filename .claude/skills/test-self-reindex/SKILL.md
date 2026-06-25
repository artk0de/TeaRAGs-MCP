---
name: test-self-reindex
description:
  Index the current tea-rags worktree as a separate `tea-rags-worktree` project
  alias and verify end-to-end reindexing behavior on the worktree's own source.
  Auto-invoke when the user asks to "test reindexing", "проверить реиндексацию",
  "test tea-rags self-reindex", "регрессия реиндексации", "test self-reindex on
  worktree", "smoke test enrichment on worktree", or any phrasing that means
  "run a live tea-rags self-test against the current worktree's code". Use this
  skill instead of indexing the main `tea-rags` project alias when you want to
  exercise unreleased worktree code without disturbing the main project's index.
---

# Self-Reindex Smoke Test (Worktree)

Use this skill to exercise the **freshly-built tea-rags MCP server** against the
**current worktree's own source tree**, registered as a SEPARATE project alias
(`tea-rags-worktree`) so the main `tea-rags` index is untouched.

This is the live counterpart to the test suite — `npx vitest run` checks code
correctness, this skill checks that the end-to-end indexing + enrichment +
metric-computation pipeline actually works against real code that exercises
every walker / resolver / preset declared in the worktree.

## When to invoke

- User says some variant of "test reindexing", "проверить реиндексацию", "test
  tea-rags self-test", "smoke test the worktree", "регрессия на собственном
  коде".
- After a non-trivial change to ingest pipeline, enrichment coordinator,
  codegraph provider, or marker-store — before declaring a feature done.
- After bumping `.qdrant-required-version` or migrating payload schema.

## When NOT to invoke

- The change is doc-only, test-only, or rule-only — no production code path
  shifted; skip.
- The user is debugging a specific tool against the MAIN `tea-rags` alias (they
  want their cache, not a fresh one).
- `npm link` is not pointing at the current worktree (run the link-flip from
  `.claude/CLAUDE.md` § "MCP Integration Testing" first; without it, this skill
  exercises stale published code).

## Pre-flight

Before doing anything else, verify the global symlink points at the worktree
you're testing. If not, surface that to the user and STOP — testing against a
stale link is worse than not testing at all.

```bash
readlink "$(npm root -g)/tea-rags"
# Must contain the current worktree path (e.g. .claude/worktrees/<branch>).
```

If the link is stale or absent, ask the user to run (from the worktree):

```bash
npm run build && npm link
```

…then reconnect MCP servers (`/mcp` → reconnect tea-rags) and rerun this skill.

## Workflow

### Step 1 — Resolve the worktree path

The cwd should already be the worktree (`.claude/worktrees/<branch>` under the
main tea-rags-mcp repo). If the user provided a path, use it; otherwise use the
current working directory via `pwd`. Worktree path must be an **absolute** path.

### Step 2 — Register + force-reindex in one CLI command

`--name tea-rags-worktree` registers the worktree path under the static alias
and then indexes, all in one command. **Alias-rename semantics** still apply:
when the name already points at a stale (deleted) path, register RE-POINTS the
existing entry at the new worktree path — the physical Qdrant collection,
snapshot file and codegraph DB stay intact (no data dropped, no forced reindex
from the rename alone). `--force` then rebuilds the index from scratch;
`--wait-enrichments` stays attached until every enrichment provider finishes;
`--json` emits a parseable result.

```bash
tea-rags index-codebase <absolute-worktree-path> --name tea-rags-worktree --force --wait-enrichments --json
```

This rebuilds from scratch — exercises chunker, all extraction walkers (TS / JS
/ Python / Ruby / Go / Java / Rust / Bash), all symbol-table inserts, the graph
adapter, Tarjan SCC, PageRank, payload writers, and the enrichment coordinator
(markStart → file-phase → chunk-phase → markFileFinal / markChunkFinal). Because
`--wait-enrichments` blocks until completion, the command returns only after
enrichment settles — no log polling needed. (Bound it with a hard wall-clock
limit of ~5 minutes via the Bash `timeout` parameter so a hung enrichment
doesn't lock the session.)

### Step 3 — Verify all four enrichment levels reach `healthy`

```
mcp__tea-rags__get_index_status project: "tea-rags-worktree"
```

Expected:

- `enrichment.git.file.status === "healthy"`
- `enrichment.git.chunk.status === "healthy"`
- `enrichment.codegraph.symbols.file.status === "healthy"`
- `enrichment.codegraph.symbols.chunk.status === "healthy"`

Anything else — `in_progress`, `failed`, `degraded` — is a regression. Surface
the raw payload of the metadata point for diagnosis:

```bash
# UUID = sha256("__indexing_metadata__") trimmed to UUID format
curl -s "<qdrant-url>/collections/<collection>/points/<uuid>" | jq .
```

### Step 4 — Functional smoke tests against the new alias

Run a short battery to confirm the codegraph + composite-preset path works
end-to-end on the freshly indexed alias. Each call should succeed and return
non-empty results.

| Call                                                                                                   | Validates                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mcp__tea-rags__find_cycles project: "tea-rags-worktree" scope: "file"`                                | Tarjan SCC over file edges; produces real cycles for tea-rags-mcp (contracts triangle, git metrics pair)                                                                                                                                     |
| `mcp__tea-rags__find_cycles project: "tea-rags-worktree" scope: "method"`                              | Method-graph SCC path                                                                                                                                                                                                                        |
| `mcp__tea-rags__get_callers symbolId: "EnrichmentCoordinator#awaitCompletion"` (any well-known symbol) | Symbol-table → adapter retrieval. Use `#` for instance methods per `.claude/rules/symbolid-convention.md`; `.` is for static / classmethod. A `.` form here returns empty results silently — that's a convention mismatch, NOT a regression. |
| `mcp__tea-rags__semantic_search query: "configuration parsing" rerank: "architecturalHub"`             | Composite preset override resolves; rerank attaches overlay                                                                                                                                                                                  |
| `mcp__tea-rags__semantic_search query: "trajectory registry" rerank: "blastRadius"`                    | Composite preset uses `codegraph.file.fanOut`/`transitiveImpact` correctly                                                                                                                                                                   |

Any tool returning an InputValidationError, empty result, or stack trace is a
regression — surface the raw error to the user before claiming success.

### Step 5 — Report

Summarize the outcome in a compact table. Show:

- alias / collection / chunk count (from `get_index_status`)
- enrichment durations per provider per level
- functional check pass/fail
- any markers stuck on `in_progress` or `failed`

If everything is green, end with a one-line `result:` declaring the smoke
passed. If anything failed, write `needs input:` describing what broke so the
user can decide whether to fix-forward or revert.

## Anti-patterns

- **Testing against the main `tea-rags` alias.** That alias is the user's
  working index; reindexing it disrupts their search history and stats. Always
  use a SEPARATE alias (`tea-rags-worktree`) for self-tests.
- **Skipping the link verification.** If `npm root -g`/tea-rags doesn't point at
  this worktree, the MCP server is running PUBLISHED code and the test validates
  nothing about your local changes.
- **Re-introducing a manual enrichment-wait loop.** `--wait-enrichments` already
  blocks until every provider finishes, so the Step 2 command returns only after
  enrichment settles — do not poll `get_index_status` or the pipeline log to
  wait.
- **Declaring success while file-level enrichment is `in_progress`.** The user
  cares about end-state health, not intermediate. With `--wait-enrichments` the
  command returns settled; the Step 3 health check is the gate — re-check status
  if anything reads non-`healthy`.
- **Mutating the worktree source between Step 2 and Step 4.** That invalidates
  the index you just built. If you need to edit source, re-run from Step 2.
