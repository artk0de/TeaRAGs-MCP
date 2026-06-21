# yl9tv — Task 5 + 6 Execution Handoff

Tasks 1–4 are committed and green on `worktree-per-language-test-patterns`. This
note captures the precise mechanism map (from a code survey) so Task 5
(cross-pass channel) + Task 6 (live determinism validation) execute without
re-investigation. Task 5's correctness is only verifiable by Task 6's live run
(huginn ×2 → stable `callsAttempted`), which needs an MCP reconnect — do them
together.

## Done so far

| Task            | Commit     | Summary                                                                                        |
| --------------- | ---------- | ---------------------------------------------------------------------------------------------- |
| (pre) cnqrg WIP | `3727cd11` | per-language `cg_run_stats` grain (unrelated, was uncommitted)                                 |
| 1               | `1ff870a6` | additive `emitExtraction`/`extraction` on worker-protocol                                      |
| 2               | `bf2e9ad3` | `collectSymbols` → `language/kernel`, provider via DI (`CollectSymbolsFn`)                     |
| 3               | `60d2cd10` | `TreeSitterChunker#chunkWithTree` seam; worker emits `FileExtraction` from one parse           |
| 4               | `7022b7e4` | `ChunkerPool#processFile` propagates extraction; `chunkerPoolSize` default 4→1 (single-flight) |

Follow-up bead: `tea-rags-mcp-5wkq6` (extract `language/kernel` standalone
module).

## Task 5 — cross-pass channel (chunk pass tees extraction into codegraph spill)

All paths in worktree `.claude/worktrees/per-language-test-patterns`.

### Current mechanism (provider.ts)

- `asExtractionSink(collectionName?)` → `{ write(extraction), finish() }` (lines
  596–794).
  - runId `randomUUID()` (621); spillPath via
    `pool.spillPathFor(collection, runId)` pool mode /
    `cwd/.tea-rags-codegraph-spill/direct-${runId}.ndjson` direct (622–627).
  - Stream created LAZILY on first `write` via `ensureSpillStream()` (632–641,
    739).
  - `finish()` closes stream then
    `streamingResolveAndUpsert(spillPath, collection)` (775).
- `streamFileBatch` (1208–1227) → serialized `streamFileBatchInner` (1229–1285).
  - First batch creates sink lazily: `asExtractionSink(...)` (1255), stored in
    `runSinks` (1256).
  - **Pool-mode parse to neutralize:** loop calls
    `this.extractOneFile(root, relPath)` (1276) then
    `await sink.write(extraction)` per file; dedup via `extracted` set
    (1274/1277).
  - Returns empty map (signals deferred to finalize).
- `finalizeSignals` (1295–1318): `sink.finish()` (1300) → `readFileOverlays`
  (1304) → `recordRunStats` (1310); finally deletes
  `runSinks`/`runExtractedPaths`/`runBatchChains` + `clearRunState`.
- `extractOneFile` (1471–1509): the parse (parser.parse → `collectSymbols` →
  `walker.walk`). KEEP as direct-mode fallback (called by `buildFileSignals`
  1148 + the pool-mode `streamFileBatchInner` 1276).

### Edits

1. **provider.ts**
   - Add
     `acceptExtraction(extraction: FileExtraction, options?: { collectionName?: string }): Promise<void>`
     that resolves/creates the run sink for the collection key and
     `sink.write(extraction)`, and records the relPath in `runExtractedPaths`
     (so `finalizeSignals` knows the path set).
   - Lift sink creation OUT of the lazy first-batch into an eager run-start (a
     `beginExtractionRun(collectionName)` invoked at index start) so
     `acceptExtraction` can write before any `streamFileBatch`. Keep the
     `runSinks` map keyed by collection.
   - Make pool-mode `streamFileBatchInner` a NO-OP for parsing: drop the
     `extractOneFile` call (1276) when the run is fed by the chunk pass
     (extraction already spilled). Keep the dedup
     `extracted`/`runExtractedPaths` bookkeeping. Direct mode (no hook wired,
     tests) STILL uses `extractOneFile` — gate on whether the cross-pass hook
     populated the run.
   - `finalizeSignals` unchanged (reads the spill, resolves pass-2).

2. **file-processor.ts**
   - At the `chunkerPool.processFile` call site (line 184) already destructures
     `extraction` (Task 4). After it:
     `if (extraction && onExtraction) await onExtraction(relativePath, extraction);`
   - Add
     `onExtraction?: (relPath: string, extraction: FileExtraction) => Promise<void>`
     to `FileProcessorOptions` (~line 65).

3. **base.ts `setupEnrichmentHooks` (263–274)**
   - Mirror the `setOnBatchUpserted` git bridge (271–272): wire a
     `setOnExtraction`-style callback from the chunk pass to the codegraph
     provider via the coordinator (no domain-boundary violation — callback
     bridges through the coordinator).
   - Reach the codegraph provider through the coordinator/registry the same way
     the file phase does (`file-phase.ts:162` optional `streamFileBatch`
     presence check); add a parallel optional `acceptExtraction` presence check.

### Test — `tests/core/domains/ingest/pipeline/codegraph-extraction-bridge.test.ts`

- Feed two `FileExtraction`s through the bridge → assert both land in the spill
  and `finalizeSignals` resolves them with ZERO `extractOneFile` calls in pool
  mode (spy on `extractOneFile`). Single-owner provider tests stay green via
  direct-mode fallback.

## Task 6 — live determinism validation (NEEDS MCP reconnect)

Per `.claude/CLAUDE.md` MCP workflow + `.claude/rules/.local/mcp-testing.md`:

1. `npm run build` (tsc=0) + `npx vitest run` (all green, coverage ≥ threshold).
2. `cd` worktree → `npm run build && npm link` → reconnect MCP servers
   (AskUserQuestion).
3. `force_reindex project=tea-rags` and `force_reindex project=huginn`.
4. Index huginn 2× → read `cg_run_stats` `callsAttempted` (or `get_index_status`
   codegraph `resolveSuccessRate`) — MUST be STABLE across runs (was 11886↔15677
   = ±32%). Record both values.
5. Spot-check chunk determinism at the single-flight default by indexing a
   multi-file ruby project twice and diffing `callsAttempted`.
6. Merge worktree → main, `npm run build && npm link` on main, reconnect MCP.

## Risk note (from plan self-review)

Task 5 is the largest change and touches the churn-hotspot `provider.ts` run
lifecycle. If a reviewer could reject the spill-lifetime change independently of
the bridge, split Task 5 into 5a (provider `acceptExtraction` + eager spill +
pool-mode no-op) and 5b (file-processor forward + base.ts hook) with the bridge
test gating 5b.

## Task 6 OUTCOME — live determinism FAILED; Task 5b required (bead tea-rags-mcp-why9b)

Live probe (huginn `force_reindex` ×2 on the worktree build) showed
callsAttempted is NOT stable: Run 1 = 12622, Run 2 = 14899 (~18% jitter
persists; byLanguage breakdown also inconsistent between runs).

Root cause: codegraph enrichment runs OFF-THREAD (`workerDescriptor` +
`WorkerPoolEnrichmentExecutor`, collection-affinity). The executor routes
`runFileBatch`/`finalizeSignals` to a WORKER instance via `buildCallRequest`
(`executor/worker-pool.ts`), where a fresh `createCodegraphEnrichmentProvider`
runs them. But `coordinator.onFileExtraction` calls `acceptExtraction` on the
MAIN-thread provider instance (`coordinator.contexts`) — a DIFFERENT object. So:

- the worker's `runFedByChunkPass` is never set → its `streamFileBatch` keeps
  the `extractOneFile` re-parse → still races the chunker pool's parse
  (process-global tree-sitter corruption) → jitter persists.
- the main-thread `acceptExtraction` creates a sink that is NEVER finalized
  (finalize runs in the worker) → spill-file/handle LEAK per run.

Unit tests passed because they exercise the DIRECT-mode (main-thread) provider;
the off-thread worker path is not covered by unit tests.

Mitigation applied: the live `onFileExtraction` wiring in `indexing.ts` is gated
OFF (commit after `64a27859`). The worker keeps `extractOneFile` (Tasks 1–4
baseline — correct, single-flight chunker, just not the determinism win). All
Task 5 infra (`acceptExtraction`, `coordinator.onFileExtraction` /
`acceptsExtractions`, `file-processor.onFileExtraction`, pool `emitExtraction`)
stays as scaffolding.

### Task 5b approved design — worker-owned input spill, main writes

1. **Main `acceptExtraction`**: sync-append the raw `FileExtraction`
   (root-relative `relPath`) to a DETERMINISTIC input spill
   `pool.spillPathFor(collection, "xpass-input")`. NO sink, NO finalize on main.
   Dedup via a main-side per-collection set. Truncate at run start via a new
   optional `EnrichmentProvider.beginExtractionRun(collection)` called from
   `coordinator.beginRun`.
2. **Run-level `crossPass` flag** threaded through `FileSignalOptions` →
   executor → worker. TRUE only when the run actually FEEDS the input spill. The
   FULL-index path (`indexing.ts`) wires `onFileExtraction`; **`reindex_changes`
   is a SEPARATE `ReindexPipeline` that does NOT** — it must stay
   `crossPass=false` so the worker keeps `extractOneFile` (no
   incremental-codegraph regression). Thread the flag from the pipeline through
   `setupEnrichmentHooks`/`beginRun` → `RunState` → file-phase
   `FileSignalOptions`, NOT from provider capability.
3. **Worker `streamFileBatch`**: `if (options.crossPass) return new Map()` (no
   parse).
4. **Worker `finalizeSignals`**: if `crossPass`, `ensureRunSink`, drain the
   input spill line-by-line via `sink.write` (pass-1 symbol upsert + worker
   resolve-spill, deduped), `rm` the input spill, THEN the existing `finish()`
   (pass-2 resolve). `extractOneFile` stays the non-crossPass + direct-mode
   fallback. `spillPathFor(collection, marker)` is deterministic and main+worker
   pools share `rootDir` → identical path.

### 5b validation (mandatory — BOTH paths)

- `force_reindex huginn` ×2 → `get_index_status` codegraph `callsAttempted`
  STABLE.
- `reindex_changes` on a ruby project ×2 → codegraph still enriches changed
  files (no regression) + stable. Re-enable the `indexing.ts` `onFileExtraction`
  wiring as part of 5b.

## Task 5b IMPLEMENTED (worker-owned input spill) — unit-green, live pending

Implemented per the approved design. tsc=0, eslint=0; targeted suites green
(ingest 1568, codegraph/enrichment/duckdb 776, bridge contract rewritten).

Mechanism (9 production files + 1 test):

1. `adapters/duckdb/pool.ts` — `inputSpillPathFor(coll)` →
   `<rootDir>/codegraph/ .xpass/<coll>.ndjson`. CRITICAL: `.xpass` is a SIBLING
   of `.spill`; the pool constructor `rmSync`s only `.spill`, and the worker
   builds its OWN pool mid-run (first dispatch) — putting the input spill in
   `.spill` would let the worker wipe the main's in-flight spill. `.xpass` is
   never purged. Deterministic (no runId): main + worker pools share `rootDir` →
   identical path.
2. `contracts/types/provider.ts` — `FileSignalOptions.crossPass?: boolean`;
   `EnrichmentProvider.acceptExtraction` now returns `void` (sync append, called
   only on the main instance) + new `beginExtractionRun?(coll)`.
3. `codegraph/symbols/provider.ts`:
   - `acceptExtraction` (MAIN): sync `appendFileSync` of the raw
     `FileExtraction` (root-relative relPath) to the input spill, deduped per
     collection via `xpassWritten` set. No sink, no symbol upsert, no finalize
     on main.
   - `beginExtractionRun` (MAIN): truncate the input spill + reset dedup at run
     start.
   - `streamFileBatchInner`: parse-gate is now
     `if (options?.crossPass) return ∅` (was the `runFedByChunkPass` in-process
     Set — removed; an in-process flag can't reach the off-thread worker, the
     whole Task-5 bug).
   - `finalizeSignals` (WORKER): on `crossPass`, `drainInputSpill` streams the
     main-written NDJSON line-by-line through a fresh sink (pass-1 symbol
     upsert + output-spill append), `rmSync`s the input spill, then the existing
     `sink.finish()` resolves pass-2. `extractOneFile` stays the non-crossPass +
     direct-mode fallback.
4. Threading (flag from PIPELINE, not provider capability — survives the worker
   structured-clone boundary as a primitive):
   `IndexPipeline.crossPassExtractionEnabled()` =
   `enrichment.acceptsExtractions()` (base default `false` → `ReindexPipeline`
   keeps `extractOneFile`) → `setupEnrichmentHooks` →
   `coordinator.beginRun(…, crossPass)` → `RunState.crossPass` →
   `filePhase.init(…, crossPass)` → streamFileBatch options (onBatch) +
   `filePhase.crossPassEnabled` → `completion-runner` runFinalize options. The
   SAME gate wires `onFileExtraction` in `IndexPipeline.processAndTrack`
   (re-enabled), so the main writes the spill iff the worker expects it.

Live dual-path validation still REQUIRED before merge (the Task-5 lesson: unit
green ≠ off-thread correct):

- `force_reindex huginn` ×2 → `callsAttempted` STABLE (was 12622 vs 14899).
- `reindex_changes` ruby ×2 → codegraph still enriches, no regression
  (crossPass=false on that path).
