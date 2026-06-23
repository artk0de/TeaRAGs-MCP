# Producer File-Units Progress Report

## Status: DONE

## Is the applier per-run?

Yes. `createRunState()` in `coordinator.ts` instantiates a fresh
`EnrichmentApplier` on every `beginRun()` call. Both `filesByProvider`
(Map<string, Set<string>>) and `chunksByProvider` (Map<string, number>) live on
the applier instance, so they start empty for every run. No reset method is
needed.

## New `beginRun` signature

```typescript
beginRun(
  absolutePath: string,
  collectionName?: string,
  ignoreFilter?: Ignore,
  _changedPaths?: string[],
  crossPass = false,
  fileCount = 0,          // ← NEW trailing param; default 0 for backward compat
): void
```

`fileCount` is stored as `this.grandFileCount` and reset to 0 at every
`beginRun`.

## Files changed

1. `src/core/domains/ingest/pipeline/enrichment/applier.ts`
   - Added `filesByProvider: Map<string, Set<string>>` and
     `chunksByProvider: Map<string, number>` private fields.
   - `applyFileSignals`: tracks relPaths into `filesByProvider.get(providerKey)`
     Set (deduped), emits `{ applied: providerFileSet.size }` (cumulative
     distinct files) instead of `applied: operations.length`.
   - `applyFinalizeFile`: tracks all relPaths from `chunkMap.keys()`, emits
     cumulative file count.
   - `applyChunkSignals`: accumulates into `chunksByProvider`, emits cumulative
     chunk count (not a delta).

2. `src/core/domains/ingest/pipeline/enrichment/coordinator.ts`
   - Added `grandFileCount = 0` and `chunkTotalAccumulated = 0` instance fields.
   - `beginRun`: accepts new `fileCount` param; stores as `grandFileCount`,
     resets `chunkTotalAccumulated`.
   - `onChunksStored`: removed per-provider `addProgressTotal("file")` calls;
     now only `chunkTotalAccumulated += items.length`.
   - `emitProgress`: SET (not accumulate) applied from event; compute
     `total = grandFileCount` (file level) or `chunkTotalAccumulated` (chunk
     level). Removed dead `addProgressTotal` method.

3. `src/core/domains/ingest/pipeline/base.ts`
   - `initProcessing` and `setupEnrichmentHooks` both accept `fileCount = 0`
     trailing param.
   - Forwards to `this.enrichment.beginRun(..., fileCount)`.

4. `src/core/domains/ingest/operations/indexing.ts`
   - `initProcessing` call passes `files.length` as `fileCount`.

5. `src/core/domains/ingest/operations/reindexing.ts`
   - `initProcessing` call passes `ctx.currentFiles.length` as `fileCount`.

6. `tests/core/domains/ingest/pipeline/enrichment/coordinator.test.ts`
   - Updated 4 existing progress tests to new semantics (file units,
     grandFileCount denominator).
   - Added 4 new tests: file dedup across batches, lock-step regression guard,
     chunk cumulative, run reset.

## Test results

- `coordinator.test.ts`: 104 tests ✓
- `applier.test.ts`: 25 tests ✓
- `tests/core/domains/ingest/` + `tests/core/api/`: 1978 tests ✓
- `tests/cli/`: 517 tests ✓
- `npx tsc --noEmit`: 0 errors
- `npx eslint <changed files>`: 0 errors
