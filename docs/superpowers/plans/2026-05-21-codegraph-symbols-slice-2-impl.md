# Codegraph Slice 2 Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` (or
> `dinopowers:executing-plans`) to implement task-by-task. Steps use checkbox
> (`- [ ]`) syntax.

**Goal:** Land architectural follow-ups from Slice 1 (registry-driven
enrichment, per-provider metrics, DuckDB shared daemon) AND full
incremental-indexing support for codegraph, then layer Tier 2-3 graph metrics
(transitiveImpact, find_cycles, pageRank) on top of a clean foundation.

**Architecture:** Phase A removes Slice 1's invasive shims so that adding new
providers/trajectories becomes additive. Phase A also closes the
incremental-indexing gap: codegraph must correctly handle deleted files,
modified files (no edge accumulation), and cross-file resolution across partial
reindexes. Phase B introduces the cycle-detection table + graph-metric signals
on top of the now-stable foundation.

**Tech Stack:** TypeScript (NodeNext ESM), DuckDB (@duckdb/node-api), Vitest,
tree-sitter, Tarjan SCC algorithm, iterative PageRank.

**Spec:**
`docs/superpowers/specs/2026-04-25-codegraph-symbols-vertical-slice.md` (Slice 1
done; Slice 2 deferred sections + new incremental-indexing requirement)

**Beads epic:** `tea-rags-mcp-l26`

---

## Non-Goals (Slice 3+)

- Python / Ruby / Elixir extraction hooks (Slice 3)
- Regex-fallback resolver for unknown languages (Slice 3)
- PostgreSQL `GraphDbClient` backend with declarative FK + CASCADE (Slice 4)
- Temporal sub-graph (cg*temporal*\*) and `TemporalTrajectory` (Slice 5)
- Path-tracing / cluster-detection MCP tools (Slice 6 — `tea-rags-mcp-uxsr`)
- Auto-background backfill on activation (separate spec)
- Removing legacy `imports[]` payload field (separate refactor)

## Task Dependency DAG

```
A1 (f5kk) ─────┐
A2 (5qnw) ─────┼─→ A4a (deletion-hook) → A4b (modify-semantics) → A4c (symbol-hydration) → A4d (sync-wiring) ─→ B1 → B2 → B3 → [B4]
A3 (pwx5) ─────┘
```

- A1, A2, A3 are independent and can run in parallel; recommended order is A1 →
  A2 → A3 (smallest design risk first).
- A4 chain is sequential — each step exercises the previous step's contract.
- B1 (transitiveImpact) and B2 (find_cycles) share the cycle-aware traversal
  helper; B1 first so the helper is well-tested by B2.
- B3 (pageRank) is independent of B1/B2 but later for compute-budget reasons.
- B4 (betweenness) is a candidate cut — evaluate after B3 is live.

---

## Phase A — Foundation

### Task A1: Registry-driven IngestFacade (replaces `extraEnrichmentProviders` shim)

**Beads:** `tea-rags-mcp-f5kk`

**Files:**

- Modify: `src/core/api/internal/facades/ingest-facade.ts` (remove
  `extraEnrichmentProviders` field; consume
  `registry.getAllEnrichmentProviders()`)
- Modify: `src/bootstrap/factory.ts` (drop `.filter(p => p.key !== "git")`
  workaround)
- Modify: `src/core/api/internal/composition.ts` (git provider construction
  moves here, into a trajectory factory)
- Modify: `src/core/domains/trajectory/git/index.ts` (export factory
  `createGitTrajectory(config, squashOpts)`)
- Test: `tests/core/api/composition.test.ts` (regression: registry-driven path
  returns single git provider, no double-instantiation)
- Test: `tests/core/api/internal/facades/ingest-facade.test.ts` (regression:
  pipeline receives provider list from deps.registry, not
  deps.extraEnrichmentProviders)

**RED:** Write failing test that asserts `IngestFacadeDeps` no longer accepts
`extraEnrichmentProviders`, that composition wires git via the trajectory
factory, and that `buildIngestPipeline` does NOT construct
`new GitEnrichmentProvider()` inline.

**GREEN:** Move git provider construction into
`createGitTrajectory(trajectoryConfig.trajectoryGit, squashOpts)`. Register it
from composition. `IngestFacade.buildIngestPipeline` reads
`deps.registry.getAllEnrichmentProviders()` as the single source of truth.
Delete `extraEnrichmentProviders` field from `IngestFacadeDeps`.

**Constraints:** GitEnrichmentProvider constructor signature stays unchanged.
The threading of `trajectoryConfig.trajectoryGit + squashOpts` moves up one
layer (composition), not into IngestFacade.

**Commit:**
`refactor(facades): drive IngestFacade enrichment providers from TrajectoryRegistry`

---

### Task A2: Per-provider EnrichmentMetrics

**Beads:** `tea-rags-mcp-5qnw`

**Files:**

- Modify: `src/core/types.ts` (extend `EnrichmentMetrics` with
  `byProvider: Record<string, ProviderMetrics>`)
- Modify: `src/core/contracts/types/provider.ts` (add `ProviderMetrics` shape —
  optional in contract since not all providers track per-run stats)
- Modify: `src/core/domains/ingest/pipeline/enrichment/coordinator.ts`
  (aggregate per-provider stats in `awaitCompletion`)
- Modify: `src/core/domains/trajectory/codegraph/symbols/provider.ts` (track
  `extractedFiles`, `fileEdgeCount`, `methodEdgeCount`, `resolveSuccessRate` per
  run; surface via `ProviderMetrics`)
- Modify: `src/core/api/public/dto/index.ts` (extend `IndexStatusDTO` enrichment
  block with per-provider keys)
- Modify: `src/core/api/public/app.ts` (`get_index_status` surfaces
  `byProvider`)
- Test: `tests/core/types/enrichment-metrics.test.ts`,
  `tests/core/domains/trajectory/codegraph/symbols/provider.test.ts` (new
  assertions on metrics shape)

**RED:** Existing git-only `EnrichmentMetrics` doesn't capture codegraph stats —
`get_index_status.enrichment.byProvider["codegraph.symbols"]` returns undefined.

**GREEN:** Introduce `ProviderMetrics` interface with provider-specific shape.
Git keeps current keys (`gitLogFileCount`, `chunkChurnDurationMs`, etc.) but
under `byProvider.git`. Codegraph adds its own keys. DTO/MCP layer surfaces
`byProvider` as a `Record<string, unknown>`.

**Backward compat:** Top-level keys (`prefetchDurationMs`, `totalDurationMs`,
`matchedFiles`, `missedFiles`) preserved — these are coordinator-owned, not
provider-owned.

**Commit:**
`feat(metrics): per-provider EnrichmentMetrics with codegraph extraction stats`

---

### Task A3: DuckDB shared daemon (replaces graceful-lock workaround)

**Beads:** `tea-rags-mcp-pwx5`

**Files:**

- Create: `src/core/adapters/duckdb/daemon/server.ts` (Unix-socket / named-pipe
  IPC daemon hosting a single DuckDB connection; mirrors
  `src/core/adapters/onnx/daemon/`)
- Create: `src/core/adapters/duckdb/daemon/client.ts` (RPC client implementing
  `GraphDbClient` over IPC)
- Create: `src/core/adapters/duckdb/daemon/protocol.ts` (request/response shapes
  for graph queries: getFanIn, getFanOut, upsertFile, removeFile, listEdges,
  listCycles)
- Create: `src/core/adapters/duckdb/daemon/spawn.ts` (spawn-or-attach lifecycle;
  idle shutdown; PID file in `$paths.appData`)
- Modify: `src/bootstrap/factory.ts` (replace graceful-catch `wireCodegraph`
  with daemon-attach path)
- Modify: `src/core/adapters/duckdb/client.ts` (existing in-process client
  becomes one of two implementations behind `GraphDbClient` interface)
- Modify: `src/core/adapters/duckdb/index.ts` (barrel exports
  `createDaemonClient` / `createInProcessClient` factory)
- Test: `tests/core/adapters/duckdb/daemon/server.test.ts` (multi-client write
  serialization, idle shutdown after 30s)
- Test: `tests/core/adapters/duckdb/daemon/client.test.ts` (auto-spawn on first
  call; reconnect on daemon restart)

**RED:** Two concurrent MCP processes both try `wireCodegraph` → second one
fails (graceful-disabled). Multi-instance MCP doesn't work.

**GREEN:** Daemon owns the DB file lock; clients connect over IPC. First MCP
process spawns the daemon if not running; subsequent processes attach. Daemon
shuts down after N seconds of no clients (mirrors ONNX daemon design).

**Idle shutdown:** Match `onnx-daemon` policy — 30s idle timeout. Configurable
via `CODEGRAPH_DAEMON_IDLE_MS`.

**Commit:**
`feat(adapters/duckdb): shared daemon for multi-instance MCP graph access`

---

### Task A4: Full incremental-indexing support (NEW — 4 sub-tasks)

The incremental gap discovered during Slice 1 testing: when paths change,
codegraph DuckDB state drifts from disk reality. Four sub-tasks close the gap.

#### A4a: `handleDeletedPaths` hook on EnrichmentProvider contract

**Beads:** TBD (new) —
`Codegraph Slice 2: deletion hook on EnrichmentProvider contract`

**Files:**

- Modify: `src/core/contracts/types/provider.ts` — add optional
  `handleDeletedPaths?: (paths: string[]) => Promise<void>` to
  `EnrichmentProvider`
- Modify: `src/core/domains/ingest/pipeline/enrichment/coordinator.ts` — add
  `notifyDeletions(paths: string[])` that fan-outs to every provider with a
  `handleDeletedPaths` hook
- Modify: `src/core/domains/trajectory/codegraph/symbols/provider.ts` —
  implement `handleDeletedPaths` (calls `graphDb.removeFile(relPath)` + clears
  `symbolTable` entries for those paths)
- Modify: `src/core/domains/trajectory/git/provider.ts` — implement as no-op
  (git provider derives its data from git, no per-file cache to clear) OR delete
  unused entries from `lastFileResult` / `blameByRelPath` caches
- Test: `tests/core/contracts/types/provider.test.ts` (contract hook is
  optional)
- Test:
  `tests/core/domains/ingest/pipeline/enrichment/coordinator-deletions.test.ts`
  (deletion fanouts to all providers; missing hook is silently skipped)
- Test: `tests/core/domains/trajectory/codegraph/symbols/provider.test.ts`
  (`handleDeletedPaths` removes file from DuckDB + symbol table)

**RED:** Provider contract has no deletion path. Calling
`coordinator.notifyDeletions(["src/foo.ts"])` fails (method doesn't exist).

**GREEN:** Add optional hook. Coordinator dispatcher iterates providers.
Codegraph removes file + clears symbol-table entries.

**Commit:**
`feat(contracts): handleDeletedPaths hook on EnrichmentProvider + coordinator dispatch`

#### A4b: Modify-semantics — `removeFile + insert` replaces `INSERT OR IGNORE`

**Beads:** TBD (new) —
`Codegraph Slice 2: clear edges before re-insert for modified files`

**Files:**

- Modify: `src/core/adapters/duckdb/client.ts` — add
  `upsertFile(relPath, edges)` that wraps `removeFile(relPath) + insertEdges()`
  in a transaction
- Modify: `src/core/domains/trajectory/codegraph/symbols/provider.ts` —
  `asExtractionSink().finish()` calls `upsertFile` per modified file (currently
  INSERT OR IGNORE leaves stale edges)
- Test: `tests/core/adapters/duckdb/client.test.ts` (modify file → old edges
  gone, new edges in)
- Test: `tests/core/domains/trajectory/codegraph/symbols/provider.test.ts`
  (re-extract same file twice → edge count stable, not doubled)

**RED:** Re-extracting a file leaves the previous run's edges in DuckDB.
fanIn/fanOut for cleaned-up symbols stays elevated.

**GREEN:** `upsertFile` clears file's edges before inserting new ones;
transactional to avoid partial state on crash.

**Commit:**
`fix(adapters/duckdb): upsertFile clears edges before insert for incremental re-extraction`

#### A4c: Symbol table persistence + hydration from DuckDB

**Beads:** TBD (new) —
`Codegraph Slice 2: persist symbol table in DuckDB, hydrate on cold start`

**Files:**

- Create:
  `src/core/infra/migration/database/migrations/002-cg-symbols-table.sql` — new
  `cg_symbols` table:
  `(symbol_id PK, file_path, kind, short_name, line_start, line_end)`
- Modify: `src/core/adapters/duckdb/client.ts` — add `upsertSymbols(symbols)`,
  `lookupSymbolsByShortName(name)`, `removeSymbolsForFile(relPath)`
- Modify: `src/core/domains/trajectory/codegraph/symbols/symbol-table.ts` — make
  `InMemoryGlobalSymbolTable` optionally hydrate from a `GraphDbClient` on first
  lookup; persist via `upsertSymbols` when extraction completes
- Modify: `src/core/domains/trajectory/codegraph/symbols/provider.ts` — call
  `graphDb.upsertSymbols` after `chunkSymbolByLine` is populated; on incremental
  reindex, hydrate symbol table from DB for files NOT in `paths` before
  resolving calls
- Test: `tests/core/domains/trajectory/codegraph/symbols/symbol-table.test.ts`
  (hydration: lookup misses in memory → falls back to DB → caches result)
- Test:
  `tests/core/domains/trajectory/codegraph/symbols/provider-incremental.test.ts`
  (incremental run: caller in `paths`, callee NOT in `paths` → resolves via
  hydration)

**RED:** Incremental reindex of one file fails to resolve calls into files
outside `paths`. Cross-file edges silently missing.

**GREEN:** Symbol table reads/writes via DuckDB. Cold start reads from DB; warm
hits hit memory. `removeSymbolsForFile` called by `handleDeletedPaths` +
`upsertFile`.

**Commit:**
`feat(codegraph): persist symbol table to DuckDB with lazy hydration`

#### A4d: Deletion detection in sync layer — wire to coordinator

**Beads:** TBD (new) —
`Codegraph Slice 2: wire sync-layer file deletions to enrichment coordinator`

**Files:**

- Modify: `src/core/domains/ingest/sync/synchronizer.ts` +
  `parallel-synchronizer.ts` — when sync computes "files removed since
  snapshot", emit the list via a new `onFilesDeleted` callback before
  deletion-strategy executes
- Modify: `src/core/domains/ingest/sync/deletion/strategy.ts` — calls
  `coordinator.notifyDeletions(deletedPaths)` BEFORE `qdrant.deletePoints` (so
  codegraph DB stays consistent if Qdrant delete fails)
- Modify: `src/core/api/internal/facades/ingest-facade.ts` — wires
  `coordinator.notifyDeletions` into the sync layer
- Test: `tests/core/domains/ingest/sync/deletion/strategy.test.ts` (deletion
  calls `coordinator.notifyDeletions` first, then qdrant.deletePoints)
- Test: integration `tests/integration/codegraph/incremental-delete.test.ts`
  (delete file from disk → reindex → DuckDB no longer has edges for that path)

**RED:** Deleting a TS file leaves edges in DuckDB indefinitely. fanIn for
symbols defined in the deleted file stays positive forever.

**GREEN:** Sync layer routes deletions through coordinator → providers. Order:
notify providers → delete from Qdrant. If Qdrant delete fails, providers already
cleaned up (acceptable — leftover Qdrant points are tolerated, leftover graph
edges aren't).

**Commit:**
`feat(sync): route file deletions through EnrichmentCoordinator for codegraph cleanup`

---

## Phase B — Graph Metrics & Cycles

### Task B1: transitiveImpact (file-level BFS, depth-limited)

**Files:**

- Create: `src/core/adapters/duckdb/graph-algorithms/transitive-bfs.ts` —
  bounded BFS over file edges, configurable depth (default 5)
- Modify: `src/core/adapters/duckdb/client.ts` —
  `getTransitiveImpact(relPath, maxDepth = 5): Promise<number>`
- Modify: `src/core/domains/trajectory/codegraph/symbols/provider.ts` —
  `buildFileSignals` adds `codegraph.file.transitiveImpact`
- Modify: `src/core/domains/trajectory/codegraph/symbols/payload-signals.ts` —
  declare new signal descriptor
- Create:
  `src/core/domains/trajectory/codegraph/symbols/rerank/derived-signals/transitive-impact.ts`
- Modify:
  `src/core/domains/trajectory/codegraph/symbols/rerank/presets/blast-radius.ts`
  — add `transitiveImpact` to weights
- Tests: BFS depth limit, cycle-safety (visited set), transitive count vs
  immediate fanOut

**RED:** No transitiveImpact signal exists — agents can only see immediate
fanIn/fanOut, missing "changing X breaks 47 transitively-dependent files".

**GREEN:** BFS with visited-set (cycle-safe), depth-cap to bound cost. Caches
per-run results to avoid recomputing for sibling files in same query.

**Commit:** `feat(codegraph): transitiveImpact file signal with bounded BFS`

### Task B2: `find_cycles` MCP tool + `cg_symbols_cycles` table

**Files:**

- Create:
  `src/core/infra/migration/database/migrations/003-cg-symbols-cycles.sql` —
  `cg_symbols_cycles (cycle_id PK, scope ENUM('file','method'), member_paths/member_symbols, length, detected_at)`
- Create: `src/core/adapters/duckdb/graph-algorithms/tarjan-scc.ts` — Tarjan
  strongly-connected-components, returns cycles of length ≥ 2
- Modify: `src/core/adapters/duckdb/client.ts` —
  `findCycles(scope: 'file'|'method'): Promise<CycleEntry[]>`,
  `recomputeCycles(scope)` runs Tarjan + rewrites table
- Modify: `src/core/domains/trajectory/codegraph/symbols/provider.ts` —
  `asExtractionSink().finish()` triggers `recomputeCycles('file')` and
  `recomputeCycles('method')` (debounced — only on `finish`, not per-file)
- Create: `src/mcp/tools/find-cycles.ts` + register in `mcp/tools/index.ts`
- Create: `src/core/api/public/dto/cycle.ts` — DTO for cycles
- Modify: `src/core/api/public/app.ts` —
  `findCycles({ scope: 'file' | 'method' })` method on `GraphFacade`
- Tests: Tarjan correctness (single edge no cycle, A↔B cycle, A→B→C→A cycle,
  disconnected components, self-loop), recompute idempotency, MCP tool
  round-trip

**RED:** No way to enumerate import / call cycles in the codebase.

**GREEN:** Tarjan SCC computed at extraction-finish. MCP tool reads pre-computed
table (sub-ms query). Agents call `find_cycles(scope: "file")` to surface
circular imports.

**Commit:**
`feat(codegraph): find_cycles MCP tool with Tarjan SCC and persisted cg_symbols_cycles`

### Task B3: pageRank over method graph

**Files:**

- Create: `src/core/adapters/duckdb/graph-algorithms/page-rank.ts` — iterative
  PageRank (damping 0.85, convergence ε=1e-6, max 50 iter)
- Modify: `src/core/adapters/duckdb/client.ts` —
  `getPageRank(symbolId): Promise<number>`, `recomputePageRank()` writes results
  to a `cg_symbols_metrics` table (new migration `004`)
- Create:
  `src/core/infra/migration/database/migrations/004-cg-symbols-metrics.sql`
- Modify: `src/core/domains/trajectory/codegraph/symbols/provider.ts` —
  `buildChunkSignals` adds `codegraph.chunk.pageRank`; debounced recompute on
  extraction finish
- Modify: payload-signals + derived-signal + `blast-radius` preset weights
- Tests: PageRank convergence, sums-to-N invariant, dangling-node handling

**RED:** No method-importance ranking — agents can't distinguish "core symbol
everyone calls indirectly" from "leaf util".

**GREEN:** PageRank stored per symbol. Sparse storage (only top-K to bound table
size, e.g. top 5%).

**Commit:** `feat(codegraph): pageRank method signal with iterative damping`

### Task B4 (CANDIDATE CUT): betweenness centrality

Compute betweenness only if B1-B3 ship under budget. Brandes' algorithm is
O(V·E) — expensive on large graphs. Evaluate cost on tea-rags self-test (8k
chunks, ~700 files) before committing to this Task.

---

## Risk Register

| Risk                                                           | Mitigation                                                                                 |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| A3 daemon design adds inter-process complexity                 | Mirror onnx-daemon design exactly; reuse `spawn-or-attach` lifecycle utilities             |
| A4 symbol-table hydration adds latency to first cold query     | Lazy-load only when cross-file resolution miss; warm cache after first hit                 |
| B2 Tarjan on 700+ files might be slow                          | Bench against tea-rags; if >500ms, debounce recompute (only run on `finish`, not per-file) |
| B3 PageRank on 2700+ method edges may not converge in 50 iters | Convergence test; bump max iters if needed; fallback to current iteration's vector         |
| Schema migrations 002/003/004 add reindex cost for users       | Document in CHANGELOG; force_reindex required after upgrade                                |

## Coordinated-change candidates

- A4a/A4b/A4c/A4d touch the same provider file — keep sub-task commits small and
  well-ordered to ease review
- coordinator.ts (deep-silo per existing assessment) → A4a commit needs `Why:`
  line per silo-pairing rule

## Test Strategy

- Unit tests per task at the file-modification level (Vitest)
- Integration test for full incremental cycle (A4 culmination):
  `tests/integration/codegraph/incremental-cycle.test.ts` — index → modify file
  → reindex → assert edges replaced; delete file → reindex → assert edges gone
- B-phase: live MCP validation on tea-rags self-test after each Task
  (force_reindex; call MCP tool; assert response shape)

## Live MCP validation (after Phase A, after Phase B)

```bash
cd .claude/worktrees/codegraph-symbols-slice-1-plan
npm run build
npm link
# reconnect MCP servers in Claude Code
mcp__tea-rags__force_reindex project=tea-rags
mcp__tea-rags__get_index_status project=tea-rags    # verify byProvider metrics
mcp__tea-rags__find_cycles project=tea-rags scope=file   # B2 only
mcp__tea-rags__get_callers project=tea-rags symbol=...   # regression
```

After Phase B success: merge to main, build+link main, reconnect, force reindex
once more to seed pageRank / cycles.
