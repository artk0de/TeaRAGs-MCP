# Quarantine D4b — Embed-Phase Poison-Pill Isolation

## Status

Supersedes the **D4b** section of
`docs/superpowers/specs/2026-05-12-quarantine-design.md`, which assumed a
`WorkerPool.batchFailed` hook with per-file attribution. That hook no longer
exists: `WorkerPool` was refactored into a generic bounded-concurrency executor
over `WorkItem` that `reject()`s on exhausted retries and knows nothing about
chunks or files. This spec defines the replacement.

The read/parse half (D2/D3/D4a/D5/D6) is implemented, live-validated, and merged
on `worktree-poison-pill-quarantine` (commits `0a7b04c8`, `6e4570be`,
`a7928f12`, `9d4dce5f`).

## Problem

A chunk whose token count exceeds the embedding model's context window makes
`embedBatch` throw (`OllamaContextOverflowError`). Today that error:

1. is enriched (`enrichContextOverflowError`) and re-thrown from the batch
   handler (`chunk-pipeline.ts:328-330`);
2. is retried by `WorkerPool` (pointless — the overflow is deterministic);
3. after exhausted retries, `reject()`s the batch;
4. surfaces in `ChunkPipeline.flush()` (`chunk-pipeline.ts:226-227`), which
   rethrows the first rejection;
5. bubbles to `indexCodebase` and aborts the **entire indexing pass**
   (`IndexingFailedError`).

So **one token-dense chunk (minified bundle, base64 blob) kills the whole
index**. This is problem #1 of the quarantine epic, in the embed phase.

### Why char-based detection does not work

The model limit is in **tokens**; chunk size is capped in **characters**
(`character.ts` `maxChunkSize`). The char↔token ratio collapses exactly on the
poison case: normal code ≈ 3–4 chars/token, but base64/minified ≈ 1 char/token.
A char threshold either misses the poison (false negative) or quarantines
healthy files (false positive). The only accurate signal is the embedding
adapter's token-level overflow error. Detection therefore stays at the adapter;
this spec adds **attribution + isolation** on top of it.

## Design

### D4b.1 — Embedding-error classifier

New pure function alongside `classifyQuarantinable`
(`src/core/domains/ingest/sync/quarantine-classifier.ts`):

```ts
classifyEmbeddingQuarantinable(error: unknown, relativePath: string)
  : QuarantinableIngestError | null
```

- `OllamaContextOverflowError` (or cross-provider context-overflow) →
  `ChunkOversizedError` (phase `embed`).
- Embedding 4xx that means "this input is bad" (HTTP 400/413/422 via
  `OllamaResponseError.responseStatus`) → `EmbeddingRejectedError` (phase
  `embed`).
- Everything else — transient 5xx, 429 rate-limit, network, `Unavailable`, auth
  (401) — → `null` (left to existing retry/abort behavior; NOT a poison-pill
  file).
- An already-`QuarantinableIngestError` passes through unchanged.

### D4b.2 — Isolation in the batch handler

`ChunkPipeline` gains an optional `quarantineStore`. In the embed step of
`createBatchHandler` (`chunk-pipeline.ts:326-330`):

```ts
try {
  embeddings = await this.embeddings.embedBatch(texts);
} catch (error) {
  const wrapped = enrichContextOverflowError(error, batch.items);
  const quarantinable = this.quarantineStore
    ? classifyEmbeddingQuarantinable(wrapped, "")
    : null;
  if (!quarantinable) throw wrapped; // transient → unchanged (pool retries / aborts)
  // isolate: re-embed each chunk alone, quarantine culprits, keep survivors
  ({ items, embeddings } = await this.isolateEmbeddingFailures(batch.items));
}
```

`isolateEmbeddingFailures(items)`:

1. For each item, `embedBatch([item.chunk.content])` individually.
2. On success → keep `(item, embedding)` as a survivor.
3. On a quarantinable error → `markFailed(toRelative(item), classified)` (one
   write per culprit so distinct error codes are preserved); drop the chunk.
4. On a transient error → rethrow (pool retries the whole batch; isolation is
   re-entered next attempt).
5. Return survivors `{ items, embeddings }`.

`toRelative(item)` uses `item.codebasePath` (the absolute base on every
`ChunkItem`):
`filePath.startsWith(base) ? filePath.slice(base.length+1) : filePath`.

Steps 3–5 of the handler (build points, upsert, `onBatchUpsertedCb`) then run on
the **survivor subset only**. Because the handler returns normally, `WorkerPool`
sees success — **no retry, no reject, no pass abort**. The qdrant upsert path is
unchanged: 413 stays a transient signal for `AdaptiveBatchSizer`.

### D4b.3 — Wiring

`quarantineStore` threads `indexing.ts` / `reindexing.ts` → `initProcessing`
(`base.ts`) → `ChunkPipeline` constructor. Both pipelines already construct the
store (read/parse phase); the same instance is reused so embed-phase and
read/parse-phase failures share one `quarantine.json`.

### D4b.4 — Reused, already-built machinery

- `QuarantineStore` (sibling-file persistence, concurrency mutex) — unchanged.
- Retry-on-next-pass union + clear-on-success in `reindexing.ts` — unchanged; an
  embed-quarantined file is retried exactly like a read-quarantined one.
- `get_index_status` `quarantine.count` surface — unchanged.

## Out of scope

- Bisection isolation (O(log n) instead of O(n) re-embeds). The overflow path is
  rare; individual re-embed is simpler and correct. Optimize only if profiling
  shows it matters.
- Qdrant 413 quarantine (handled by `AdaptiveBatchSizer`).
- Embedding auth/rate-limit quarantine (transient).

## Testing

- **Unit**: `classifyEmbeddingQuarantinable` (overflow → ChunkOversized, 4xx →
  EmbeddingRejected, 5xx/429/network → null, passthrough).
- **Unit**: `ChunkPipeline` isolation — mock `embedBatch` to throw overflow on
  the full batch and on one specific chunk's solo re-embed; assert that chunk's
  file is quarantined, the others are upserted, and the handler resolves (no
  throw).
- **Live MCP**: a fixture file containing one base64/minified line that exceeds
  the model context → index pass completes (not aborted), the poison file shows
  in `get_index_status` `quarantine.count`, healthy files indexed.

## File touch list

| File                                                 | Change                                                                      |
| ---------------------------------------------------- | --------------------------------------------------------------------------- |
| `sync/quarantine-classifier.ts`                      | NEW `classifyEmbeddingQuarantinable`.                                       |
| `pipeline/chunk-pipeline.ts`                         | `quarantineStore` field; embed-catch isolation; `isolateEmbeddingFailures`. |
| `pipeline/base.ts`                                   | thread `quarantineStore` into `initProcessing` → `ChunkPipeline`.           |
| `operations/indexing.ts`, `operations/reindexing.ts` | pass `quarantineStore` to `initProcessing`.                                 |
| tests                                                | classifier unit + chunk-pipeline isolation unit.                            |

Deep-silo note: `chunk-pipeline.ts` is 100% single-author with `bugFixRate`
44–50% — commits touching it carry a `Why:` line per
`.claude/rules/silo-pairing.md`.
