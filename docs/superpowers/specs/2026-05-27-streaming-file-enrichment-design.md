# Streaming File Enrichment (unified stream/finalize) — Design

**Status:** Approved (brainstorm 2026-05-27). Next: implementation plan.

**Goal:** Make file-level enrichment stream incrementally in parallel with
embedding — a single mechanism shared by all enrichment providers (git +
codegraph) — instead of the current deferred whole-repo burst that runs after
all embeddings finish. As a direct consequence, un-gate the already-streamable
git chunk enrichment.

---

## 1. Problem & evidence

A monitored `force_reindex` of the taxdome project (~24k files / ~111k chunks):

- Chunk **embeddings** finished at t≈1028s.
- Then a post-embedding **enrichment** burst ran ~58min+ (git chunk-churn: 234s
  pathspec + ~24min hunk-mapping; codegraph file+chunk enrichment) — all after
  embedding, still in progress when killed at t≈3500s.

The user's observation: chunk vectors get embedded in time, yet _no_ enrichment
(file or chunk signals) lands until the very end. Both file and chunk enrichment
are serialized behind one slow whole-repo pass.

## 2. Current architecture — the gate (root cause)

Confirmed by reading `coordinator.ts`, `file-phase.ts`, `chunk-phase.ts`, git
`provider.ts`, codegraph `symbols/provider.ts`:

- `EnrichmentCoordinator.prefetch()` kicks off `FilePhase.startPrefetch` before
  the embedding pipeline. For each provider it calls
  `chunkPhase.markPrefetchPending(key)` (sets chunk `ready=false`) and starts
  `provider.buildFileSignals(root)` — a **whole-repo pass**.
- As embedding stores batches, `coordinator.onChunksStored` fires
  `filePhase.onBatch` + `chunkPhase.onBatch` per batch:
  - `FilePhase.onBatch` already streams the _apply_ — but only once
    `state.fileMetadata` exists. Until `buildFileSignals` resolves,
    `fileMetadata === null` → batches queue in `pendingBatches`.
  - `ChunkPhase.onBatch` queues into its own `pendingBatches` while
    `ready === false`.
- When `buildFileSignals` resolves (`file-phase.ts:152` `.then`): `flushPending`
  (drains file batches) + `chunkPhase.markReady` (drains chunk batches) — the
  whole backlog lands at once as the observed burst. Remaining files are caught
  up by the post-flush `chunkPhase.enrichRemaining`.

**The gate is not the root.** `markPrefetchPending/markReady` exists _only_ to
wait for `buildFileSignals`. The root cause is that `buildFileSignals` is a
whole-repo upfront pass:

- **git** `buildFileSignals` → one `git log` over all files + per-file blame.
- **codegraph** `buildFileSignals` (`provider.ts:1051`) does the _entire_
  pipeline in one pass: walks every file (`extractOneFile` — re-parses each
  file's AST, separate from the chunker), feeds its own `asExtractionSink`
  (`sink.write` → symbol table + `upsertSymbols` + NDJSON spill), then
  `sink.finish()` (`streamingResolveAndUpsert` +
  `recomputeGraphMetricsStreaming` = Tarjan SCC + PageRank over the whole
  graph), then reads back per-file signals. Codegraph extraction therefore does
  _not_ stream today.

## 3. Key data-dependency asymmetry

Streamable per-batch:

- **git file signals** (log + blame) — per-file independent.
- **git chunk signals** (walkCommits churn) — per-file offset-aware hunk→chunk;
  the complete map was only a perf optimisation, not a correctness requirement.
- **codegraph edge extraction** (`extractOneFile` + `sink.write`) — per-file;
  the symbol table fills incrementally.

Not streamable (need the complete data set):

- **codegraph file signals** (fanIn/fanOut/instability/isHub/transitiveImpact) —
  need the complete graph (p95, reverse BFS, SCC).
- **codegraph chunk signals** (fanIn/fanOut/pageRank) — PageRank/SCC need the
  complete method graph.

So a single "compute signals per batch" shape does not fit codegraph: its
per-batch work produces _side effects_ (graph state), and its _signals_ are
deferred. The design must split a streaming step from a finalize step.

## 4. Goals / non-goals

### Goals

- File enrichment streams per stored batch, in parallel with embedding.
- One shared mechanism across providers (no two bespoke paths).
- Un-gate git chunk enrichment (it already streams; the gate blocks it).
- Signal _values_ are unchanged — only timing/scheduling changes.
- Fold in the per-run-state release (codegraph `chunkSymbolByLine` leak) at
  finalize.

### Non-goals (YAGNI / separate work)

- Chunker–codegraph parse fusion (codegraph `extractOneFile` re-parses ASTs the
  chunker already parsed). We stream the existing `extractOneFile` per batch; we
  do not fuse the parses. Deferred (the provider comment already records this).
- Incremental whole-graph signals (streaming SCC/PageRank). Rejected — it would
  change signal values.
- The 30GB OOM inside codegraph SCC/PageRank — separate follow-up epic
  (`tea-rags-mcp-gmuf`).
- Migrating backfill/recovery off `buildFileSignals` (see §5.3).

## 5. Design

### 5.1 `EnrichmentProvider` contract (`contracts/types/provider.ts`)

Add two methods (Approach A — two explicit methods, one responsibility each):

```ts
/** Per-batch streaming file enrichment. Returns signals to apply immediately. */
streamFileBatch: (
  root: string,
  batchPaths: string[],
  options?: FileSignalOptions,
) => Promise<Map<string, FileSignalOverlay>>;

/** Deferred whole-repo finalize. Returns signals that require the complete
 *  data set (graph metrics, etc.). Applied once after the embedding stream. */
finalizeSignals: (root: string, options?: FileSignalOptions) =>
  Promise<{
    file: Map<string, FileSignalOverlay>;
    chunk: Map<string, Map<string, ChunkSignalOverlay>>;
  }>;
```

Kept as-is:

- `buildChunkSignals` — the per-batch chunk stream (git uses it; codegraph
  returns ∅ during streaming, its chunk signals come from
  `finalizeSignals.chunk`).
- `buildFileSignals` — retained for backfill/recovery/incremental
  (`EnrichmentBackfiller`, `recovery.ts`) with current behavior; the main
  pipeline no longer calls it. (§5.3)
- `fileSignalTransform` — unchanged; git still transforms `FileChurnData` →
  `FileSignalOverlay` at apply time with the real line count.

### 5.2 Per-provider behavior

**git** (`trajectory/git/provider.ts`)

- `streamFileBatch(root, batchPaths)`: per-batch `git log` over `batchPaths` +
  per-file blame → file signals (same computation as today's whole-repo pass,
  scoped to the batch). `blameByRelPath` released per batch (already fixed this
  session; now released sooner).
- `finalizeSignals`: `{ file: ∅, chunk: ∅ }` — everything streamed.
- `buildChunkSignals`: unchanged (per-batch churn).

**codegraph** (`trajectory/codegraph/symbols/provider.ts`)

- Run-sink becomes run state: created in `beginRun`, written per batch, finished
  in finalize.
- `streamFileBatch(root, batchPaths)`: `extractOneFile` + `sink.write` for
  `batchPaths` (symbol table + `upsertSymbols` + spill). Returns ∅ (no signals
  yet). The symbol table fills incrementally across batches — matches the
  existing `asExtractionSink` write/finish contract.
- `buildChunkSignals`: returns ∅ during streaming (graph not finalized).
- `finalizeSignals`: `sink.finish()` (`streamingResolveAndUpsert` +
  `recomputeGraphMetricsStreaming`) → read back both file signals
  (fanIn/fanOut/instability/isHub/transitiveImpact) and chunk signals
  (fanIn/fanOut/pageRank) → return `{ file, chunk }`.

### 5.3 Why keep `buildFileSignals` for backfill

Backfill/recovery call `buildFileSignals(root, {paths})` for targeted
re-enrichment of specific files outside the main streaming run. Migrating them
to stream/finalize widens the blast radius into more deep-silo code for no
latency win (backfill is not the streaming bottleneck). Decision: leave
`buildFileSignals` and its callers untouched; codegraph shares the underlying
`extractOneFile` / `streamingResolveAndUpsert` helpers between both paths.

### 5.4 Scheduler changes

- **`coordinator.ts`**: `prefetch()` → `beginRun()`. Inits phases + `markStart`;
  codegraph creates its run-sink here. No whole-repo `buildFileSignals` kicked
  off. `onChunksStored` trigger unchanged. `awaitCompletion` drives the finalize
  step via `CompletionRunner`.
- **`file-phase.ts`**: remove `startPrefetch` and the prefetch gate. `onBatch` →
  `provider.streamFileBatch(root, batchPaths)` → `applier.applyFileSignals`
  immediately. No whole-repo `fileMetadata`, no `pendingBatches`. Add a finalize
  apply path for `finalizeSignals.file`.
- **`chunk-phase.ts`**: drop `ready` gate, `markPrefetchPending`, `markReady`,
  `pendingBatches`. `onBatch` dispatches `buildChunkSignals` immediately.
  `enrichRemaining` stays as catch-up. Add a finalize apply path for
  `finalizeSignals.chunk`.
- **`completion-runner.ts`**: new finalize step — for each provider call
  `finalizeSignals(root)` and apply file+chunk overlays, then the existing
  backfill/marker flow.

Removing the gate machinery simplifies the deep-silo coordinator/chunk-phase hub
(a tech-debt + hotspot epicenter) rather than adding to it.

### 5.5 Streaming matrix (what streams vs defers)

See §3 for streamability; the resulting schedule:

- **Stream (parallel with embedding, per `onChunksStored` batch):** git file
  signals, git chunk signals, codegraph edge extraction.
- **Finalize (once, after embedding stream):** codegraph file signals, codegraph
  chunk signals; git catch-up via `enrichRemaining` only.

### 5.6 Lifecycle / per-run state release

codegraph run-global maps (`chunkSymbolByLine`, `runAncestors`,
`runPrependedAncestors`, `runExtends`, `runReturnTypes`, `runDispatchTables`,
`runCallbackParams`) are populated during streaming, consumed by the finalize
resolve, and **cleared at the end of finalize**. This fixes the bug-hunt leak:
`chunkSymbolByLine` is currently never cleared and grows monotonically (one
relPath entry per file, persisting on the long-lived daemon). The clear is keyed
to the finalizing collection's run, not global (a daemon may serve multiple
collections concurrently).

### 5.7 Payload write invariant — file ↔ chunk isolation

A recurring class of bug: a chunk-level payload write clobbers the file-level
payload on the same point (or vice versa). It matters more here because the
codegraph finalize writes BOTH levels to the same chunk points (file signals
land on every chunk of a file; chunk signals land on those same chunk points),
so file and chunk writes provably collide on shared points.

`EnrichmentApplier` already writes each level under a distinct nested Qdrant key
path via `batchSetPayload` `op.key`:

- file → `set_payload(payload=<overlay>, key="<provider>.file")`
- chunk → `set_payload(payload=<overlay>, key="<provider>.chunk")`

Qdrant `set_payload` with a nested `key` assigns at that path and preserves
siblings. The invariant the design locks in (and the plan must test):

1. **Every enrichment write MUST set `op.key` to `<provider>.file` or
   `<provider>.chunk`.** Never write the bare `<provider>` object, never write
   at root in a way that root-merge replaces the sibling level.
2. **A file write touches only `<provider>.file.*`; a chunk write touches only
   `<provider>.chunk.*`.** Overlays carry bare inner keys (e.g.
   `{ fanIn, fanOut }`), nested by `key` — not pre-nested
   (`{ codegraph: { file: … } }`) which would force a root write.
3. The same holds for the `enrichedAt` stamp (already split into a `.file` and a
   `.chunk` stamp in `applyFileSignals`).

This invariant covers ALL writers, not just the streaming path:
`EnrichmentApplier`, `EnrichmentBackfiller`, `recovery.ts`, and any migration
write. A regression test (Qdrant integration, §7) writes file then chunk on the
same point and asserts both survive, then the reverse order.

### 5.8 Marker / status correctness — no stale markers

The marker (`{ <provider>: { file: status, chunk: status } }`) must always
reflect reality after the new schedule. The stream/finalize split changes WHEN
each level reaches `completed`:

- **file** `completed` once all file batches streamed AND (codegraph) finalize
  file overlays applied.
- **chunk** `completed` once all chunk batches streamed AND finalize chunk
  overlays applied AND `enrichRemaining` catch-up done.

Stale-marker hazards to close in the plan:

- A level left `in_progress`/`pending` after its work actually finished (the
  finalize step must write the true terminal status for BOTH levels).
- The existing `markStart`-before-finalize race guard (`awaitCompletion` awaits
  `markStartPromise`) and the `countSettledUnenriched` re-poll must still hold
  under the new schedule — verify, don't assume.
- **Reconciliation step:** at finalize, recompute the real unenriched counts per
  level (`countSettledUnenriched`) and write the true status; never leave
  `file=in_progress` when 0 unenriched, nor `completed` when some remain (→
  `degraded`). This makes `get_index_status` honest regardless of which batches
  streamed vs finalized.

## 6. Trade-offs

- **git per-batch `git log`:** N calls (one per stored batch) instead of one
  whole-repo call → more git process spawns + commit re-discovery. Overlapped
  with embedding, so wall-clock is hidden. `git cat-file --batch` (already
  landed this session) keeps blob reads cheap.
- **Memory:** per-batch file signals mean `FilePhase` no longer holds the whole
  repo's `fileMetadata` map for the run — bounded retention (a side win for the
  OOM theme).
- **codegraph:** edge extraction now overlaps embedding (faster wall-clock); the
  heavy SCC/PageRank is still a single deferred pass, but it becomes the _only_
  deferred work.

## 7. Testing strategy (TDD)

New behavioral tests:

- `streamFileBatch`: git returns per-batch file signals; codegraph extracts
  (writes to the run-sink) and returns ∅.
- `finalizeSignals`: git returns `{∅, ∅}`; codegraph returns file+chunk signals
  after `finish()` (graph metrics computed).
- Coordinator: per-batch apply with no gate; finalize applies deferred signals;
  codegraph run-state cleared after finalize (leak regression).
- **Payload isolation regression (§5.7):** Qdrant integration test (embedded
  Qdrant / `MockQdrantManager` that models nested-key `set_payload`) — write
  `<provider>.file.*` then `<provider>.chunk.*` on the same point, read back,
  assert both survive; repeat in reverse order. Covers the applier and the
  finalize path (which writes both levels to shared points).
- **Marker reconciliation (§5.8):** after a run, `get_index_status` / marker
  shows `file` and `chunk` at the correct terminal status (`completed` with 0
  unenriched, `degraded` when some remain) — never stuck `in_progress`.

Tests that asserted the gate mechanism (`markPrefetchPending`, `markReady`,
`pendingBatches`) are rewritten — the mechanism changed. **Business-logic tests
(signal computation/value correctness) are not modified** — signal values are
unchanged by this refactor.

### 7.1 Live testing (MCP integration)

Per `.claude/CLAUDE.md` MCP `npm link` workflow. After unit/integration green:

1. **Build + link the worktree:** `npm run build && npm link`; reconnect MCP.
2. **Full reset of the self-test index** (payload schedule changed, not schema —
   but exercise the streaming path end-to-end):
   `force_reindex project=tea-rags`. During the run, confirm via debug logs that
   enrichment `STREAMING_APPLY` / `STREAMING_CHUNK_ENRICHMENT_COMPLETE` events
   fire _during_ embedding (overlap), not only after.
3. **Status honesty:** `get_index_status project=tea-rags` → both `git` and
   `codegraph.symbols` show `file` and `chunk` `completed`, no stale
   `in_progress`.
4. **Payload isolation on real data:** pick an enriched chunk (`find_symbol` /
   `semantic_search`) and confirm its payload carries BOTH `git.file.*` AND
   `git.chunk.*`, AND `codegraph.symbols.file.*` AND `codegraph.symbols.chunk.*`
   simultaneously — neither level clobbered.
5. **Scale + memory (taxdome):** monitored `force_reindex` of taxdome — verify
   enrichment overlaps embedding (no ~58min post-embedding burst), memory stays
   bounded, and final `get_index_status` is `completed` for both levels.

## 8. Affected files

- `src/core/contracts/types/provider.ts` — add `streamFileBatch`,
  `finalizeSignals` (+ finalize result type).
- `src/core/domains/trajectory/git/provider.ts` — implement `streamFileBatch`
  (per-batch log+blame), `finalizeSignals` (∅); keep `buildFileSignals`.
- `src/core/domains/trajectory/codegraph/symbols/provider.ts` — run-sink as run
  state; `streamFileBatch` (extract→∅); `finalizeSignals` (finish + read back
  file+chunk); clear run-global maps at finalize.
- `src/core/domains/ingest/pipeline/enrichment/file-phase.ts` — remove prefetch
  gate; per-batch `streamFileBatch`+apply; finalize apply.
- `src/core/domains/ingest/pipeline/enrichment/chunk-phase.ts` — remove ready
  gate; immediate `onBatch` dispatch; finalize apply.
- `src/core/domains/ingest/pipeline/enrichment/coordinator.ts` —
  `prefetch`→`beginRun`; drive finalize from `awaitCompletion`.
- `src/core/domains/ingest/pipeline/enrichment/completion-runner.ts` — finalize
  step + marker reconciliation (§5.8).
- `src/core/domains/ingest/pipeline/enrichment/applier.ts` — enforce/verify the
  per-level `key` write invariant (§5.7); no behavior change expected, but the
  payload-isolation regression test anchors here.
- `src/core/domains/ingest/pipeline/enrichment/marker-store.ts` — terminal
  status reconciliation per level (§5.8).
- Tests across `tests/core/domains/ingest/pipeline/enrichment/**` and the two
  provider test files.

Deep-silo (`coordinator.ts`, both `provider.ts`) — commits carry a `Why:` line
(`.claude/rules/silo-pairing.md`).

## 9. Follow-ups (out of scope here)

- Chunker–codegraph parse fusion (eliminate codegraph's duplicate AST parse).
- 30GB OOM in codegraph SCC/PageRank (`tea-rags-mcp-gmuf`): streaming Tarjan /
  DuckDB CTE / edge cap.

## 10. References

- Gate mechanism: `coordinator.ts:179-264`, `file-phase.ts:120-235`,
  `chunk-phase.ts:104-224`.
- codegraph whole-repo pass: `symbols/provider.ts:590-776` (sink), `:933-968`
  (`recomputeGraphMetricsStreaming`), `:1051-1146` (`buildFileSignals`).
- This-session fixes that reduce memory but not latency: `git cat-file --batch`
  (`.claude/rules/git-cat-file-batch.md`), blame own-copy + `blameByRelPath`
  release, isomorphic-git removal.
