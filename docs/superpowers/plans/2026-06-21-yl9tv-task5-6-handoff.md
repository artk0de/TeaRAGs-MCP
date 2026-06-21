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
