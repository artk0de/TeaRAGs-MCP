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

### Step 2 — Register the worktree as `tea-rags-worktree`

ALWAYS use the static name `tea-rags-worktree` and ALWAYS call
`register_project` first, even when an entry already exists. `register_project`
implements **alias-rename semantics**: when the existing entry under this name
points at a stale (deleted) path, it RE-POINTS the existing entry at the new
worktree path. The physical Qdrant collection, snapshot file and codegraph DB
all stay intact — only the registry's `path` field is updated. No data is
dropped; no full reindex is forced.

```
mcp__tea-rags__register_project
  name: "tea-rags-worktree"
  path: <absolute worktree path>
```

The MCP tool returns `alreadyIndexed: true` when the rename preserved a
previously-indexed collection (worktree switch), and `alreadyIndexed: false`
when a brand-new collection is being created (first-ever worktree register).
Step 3's `forceReindex: true` runs in both cases — for a switch it exercises the
re-index path against the preserved collection; for a fresh register it performs
the first full index.

### Step 3 — Force reindex via the alias

```
mcp__tea-rags__index_codebase
  project: "tea-rags-worktree"
  forceReindex: true
```

This rebuilds the index from scratch — exercises chunker, all extraction walkers
(TS / JS / Python / Ruby / Go / Java / Rust / Bash), all symbol-table inserts,
the graph adapter, Tarjan SCC, PageRank, payload writers, and the enrichment
coordinator (markStart → file-phase → chunk-phase → markFileFinal /
markChunkFinal).

The MCP call returns when the **chunk-write** phase completes, BEFORE enrichment
finishes. Do not assume the markers are settled at this point.

### Step 4 — Wait for enrichment to settle

Enrichment runs in background. Poll the pipeline log until `ALL_COMPLETE`
appears:

```bash
until ls -t ~/.tea-rags/logs/pipeline-*.log | head -1 \
  | xargs grep -qE "ALL_COMPLETE" 2>/dev/null; do sleep 5; done
```

(Adjust timeout to match the worktree size — typical tea-rags-mcp run is ~2
minutes; bound with a hard wall-clock limit of ~5 minutes via the Bash `timeout`
parameter so a hung enrichment doesn't lock the session.)

### Step 5 — Verify all four enrichment levels reach `healthy`

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

### Step 6 — Functional smoke tests against the new alias

Run a short battery to confirm the codegraph + composite-preset path works
end-to-end on the freshly indexed alias. Each call should succeed and return
non-empty results.

| Call                                                                                                   | Validates                                                                                                |
| ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `mcp__tea-rags__find_cycles project: "tea-rags-worktree" scope: "file"`                                | Tarjan SCC over file edges; produces real cycles for tea-rags-mcp (contracts triangle, git metrics pair) |
| `mcp__tea-rags__find_cycles project: "tea-rags-worktree" scope: "method"`                              | Method-graph SCC path                                                                                    |
| `mcp__tea-rags__get_callers symbolId: "EnrichmentCoordinator.awaitCompletion"` (any well-known symbol) | Symbol-table → adapter retrieval                                                                         |
| `mcp__tea-rags__semantic_search query: "configuration parsing" rerank: "architecturalHub"`             | Composite preset override resolves; rerank attaches overlay                                              |
| `mcp__tea-rags__semantic_search query: "trajectory registry" rerank: "blastRadius"`                    | Composite preset uses `codegraph.file.fanOut`/`transitiveImpact` correctly                               |

Any tool returning an InputValidationError, empty result, or stack trace is a
regression — surface the raw error to the user before claiming success.

### Step 7 — Report

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
- **Polling `get_index_status` in a tight loop instead of watching the pipeline
  log.** The status endpoint reads from qdrant and adds load; the pipeline log
  is the cheap canonical signal.
- **Declaring success while file-level enrichment is `in_progress`.** The user
  cares about end-state health, not intermediate. Wait for `ALL_COMPLETE` and
  then re-check status.
- **Mutating the worktree source between Step 3 and Step 6.** That invalidates
  the index you just built. If you need to edit source, re-run from Step 3. //
  touch 1779362382
