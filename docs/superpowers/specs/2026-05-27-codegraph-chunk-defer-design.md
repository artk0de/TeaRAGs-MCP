# Codegraph Chunk-Signal Deferral — Design Amendment

> **Amends:**
> `docs/superpowers/specs/2026-05-27-streaming-file-enrichment-design.md` (§5.2
> codegraph) and the plan
> `docs/superpowers/plans/2026-05-27-streaming-file-enrichment.md` (Tasks 1, 3,
> 5, 7). Written 2026-05-27 after a brainstorm surfaced a gap in the original
> Task 3.

## The gap

The original plan had codegraph's `finalizeSignals(root, options?)` return a
`{file, chunk}` `FinalizeResult` — but:

1. **No chunkMap.** Chunk-level overlays must be keyed by the **Qdrant
   `chunkId`** (that is what `EnrichmentApplier.applyChunkSignals` writes to).
   `finalizeSignals` only has `paths`, and the provider's `chunkSymbolByLine`
   map holds `relPath → (startLine → symbolId)` — it never knows the chunkId. So
   `finalizeSignals` physically cannot produce a chunkId-keyed chunk overlay.
2. **Hard data dependency.** codegraph chunk signals (`fanIn` /`fanOut`
   /`pageRank`) read the DuckDB graph, which is only populated at
   `sink.finish()` (`streamingResolveAndUpsert` + `recomputePageRank`). In the
   streaming design the sink finishes at finalize (end of the run), so any
   per-batch `buildChunkSignals` for codegraph reads an empty graph → zeros.

git is unaffected: its chunk signals are per-file independent and stream
per-batch as today.

## Decision (Option A — isolated deferred pass)

codegraph's chunk computation moves to a **single isolated pass after the graph
is finalized**, reusing the proven `buildChunkSignals(root, chunkMap, opts)`
path with the full chunkMap that `ChunkPhase` already assembles from stored
chunks. git stays exactly as it is. The fragile `enrichRemaining`
(`bugFixRate 50%`) is **not** touched.

### 1. Provider capability flag

Add to `EnrichmentProvider` (`contracts/types/provider.ts`):

```ts
/**
 * When true, this provider's CHUNK signals cannot be computed per-batch —
 * they depend on the whole finalized data set (codegraph: the graph is only
 * queryable after sink.finish()). The coordinator skips per-batch chunk
 * dispatch for such providers and runs ONE buildChunkSignals pass after the
 * file-level finalize. Absent / false ⇒ chunk signals stream per batch (git).
 */
readonly defersChunkEnrichment?: boolean;
```

codegraph sets `true`; git omits it.

### 2. `finalizeSignals` becomes file-only

The `chunk` half of `FinalizeResult` is dead under this design (codegraph chunk
comes from the deferred `buildChunkSignals` pass, not from `finalizeSignals`).
Simplify the contract — **drop `FinalizeResult`**, and let `finalizeSignals`
return the file overlay map directly:

```ts
finalizeSignals?: (
  root: string,
  options?: FileSignalOptions,
) => Promise<Map<string, FileSignalOverlay>>;
```

- git: `finalizeSignals = async () => new Map()`.
- codegraph: finish the run sink, read back the **file** overlays
  (`fanIn`/`fanOut`/`instability`/`connectionCount`/`isHub`/`isLeaf`/
  `transitiveImpact`) for the extracted paths, clear run-state, return them.

This amends the already-committed Task 1 (remove `FinalizeResult`) and Task 2
(git returns `new Map()`).

### 3. `streamFileBatch`

- git: returns per-path file overlays (delegates to `buildFileSignals`).
- codegraph: extracts the batch's files into the lazily-created per-collection
  **run sink**, returns ∅ (file overlays deferred to `finalizeSignals`).

### 4. ChunkPhase deferral

For a provider whose `defersChunkEnrichment === true`:

- `onBatch` does **not** dispatch `buildChunkSignals` and does **not** add the
  files to `streamingEnrichedFiles`. It accumulates the batch's chunkMap into a
  per-provider full map (`deferredChunkMap`).
- `enrichRemaining` **skips** the provider (handled by the deferred pass).

Streaming providers (git): `onBatch` / `enrichRemaining` unchanged.

### 5. Deferred chunk pass (isolated, post-finalize)

`ChunkPhase.runDeferredChunk(coll)` — for each deferring provider, call
`buildChunkSignals(root, deferredChunkMap, { collectionName, skipCache: true })`
against the now-finished graph and apply via `applier.applyChunkSignals`. It is
driven by `CompletionRunner.run` **after** the finalize file pass and the
streaming chunk drain, **before** `markChunkFinal`. `enrichRemaining` is left
untouched.

### 6. Run-state release (leak fix — unchanged from original Task 3)

`finalizeSignals` clears `chunkSymbolByLine.get(key)` and resets the `run*` maps
for the collection after `sink.finish()`, fixing the monotonic
`chunkSymbolByLine` growth on the long-lived daemon.

## Ordering in `CompletionRunner.run`

1. drain `fileWork` (streaming file applies)
2. **finalize**: per provider `finalizeSignals` (codegraph `sink.finish` + file
   overlays) → apply file overlays; clears run-state
3. backfill (existing)
4. `markFileFinal` (+ degraded reconciliation — Task 7)
5. drain `chunkWork` (git streaming + git `enrichRemaining`)
6. **`runDeferredChunk`**: codegraph `buildChunkSignals(full chunkMap)` →
   `applyChunkSignals`
7. `markChunkFinal` (+ degraded reconciliation — Task 7)

## What does NOT change

- git's per-batch file + chunk streaming.
- `enrichRemaining` body / semantics (only skips defer-providers via a guard).
- `buildChunkSignals` / `buildFileSignals` (reused intact for the deferred pass
  and backfill).

## Plan deltas

- **Task 1** — drop `FinalizeResult`; `finalizeSignals` returns
  `Promise<Map<string, FileSignalOverlay>>`. (Re-edit the committed contract.)
- **Task 2** — git `finalizeSignals` returns `new Map()`.
- **Task 3** — codegraph `streamFileBatch` (extract, ∅) + `finalizeSignals`
  (finish, file-only readback, clear run-state) +
  `defersChunkEnrichment = true`. No `readChunkOverlays`.
- **Task 5** — ChunkPhase: defer-aware `onBatch` (accumulate + skip),
  `enrichRemaining` skip-guard, new `runDeferredChunk`.
- **Task 6** — coordinator `beginRun` + per-batch file→chunk sequencing
  (unchanged intent).
- **Task 7** — finalize pass calls `finalizeSignals` (file) then
  `runDeferredChunk` (codegraph chunk); marker reconciliation as planned.
