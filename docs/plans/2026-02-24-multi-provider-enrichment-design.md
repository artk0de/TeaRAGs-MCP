# Multi-Provider Enrichment Architecture

**Date:** 2026-02-24
**Status:** Approved
**Related:** tea-rags-mcp-q9f (config refactor — separate epic)

## Problem

ChunkPipeline is coupled to git enrichment:

1. Hardcoded `git.file.*` payload mapping (chunk-pipeline.ts lines 345-360)
2. EnrichmentCoordinator accepts only one provider
3. IngestFacade hardcodes `new GitEnrichmentProvider()`

This blocks adding new enrichment providers (code complexity, dependency graph, etc.).

## Design

### EnrichmentCoordinator — multi-provider

Single coordinator manages multiple providers internally via per-provider state:

```typescript
interface ProviderState {
  provider: EnrichmentProvider;
  prefetchPromise: Promise<...> | null;
  prefetchFailed: boolean;
  fileMetadata: Map<string, Record<string, unknown>> | null;
  pendingBatches: PendingBatch[];
  inFlightWork: Promise<void>[];
  chunkEnrichmentPromise: Promise<void> | null;
}

// Constructor changes:
// was:  new EnrichmentCoordinator(qdrant, oneProvider)
// now:  new EnrichmentCoordinator(qdrant, providers[])
```

Each public method (`prefetch`, `onChunksStored`, `startChunkEnrichment`, `awaitCompletion`)
iterates states and runs providers in parallel via `Promise.all`.

### Registry — config-driven provider factory

```typescript
// trajectory/enrichment/registry.ts
function createEnrichmentProviders(config: CodeConfig): EnrichmentProvider[] {
  const providers: EnrichmentProvider[] = [];
  if (config.enableGitMetadata) providers.push(new GitEnrichmentProvider());
  // future: if (config.enrichment?.complexity) providers.push(...)
  return providers;
}
```

### ChunkPipeline — remove git coupling

Delete hardcoded `git.file.*` payload construction (lines 345-360).
File-level metadata is already written by EnrichmentApplier via `onBatchUpserted` callback.
Removing the hardcode eliminates duplicate writes.

### Payload namespace isolation

Each provider writes under its own key via `provider.key`:
- `git.file.*`, `git.chunk.*`
- `complexity.file.*`, `complexity.chunk.*`

Already implemented in EnrichmentApplier.

## File changes

| File | Action | Change |
|------|--------|--------|
| `trajectory/enrichment/coordinator.ts` | Refactor | Single provider → ProviderState[], parallel execution |
| `trajectory/enrichment/registry.ts` | New | `createEnrichmentProviders(config) → EnrichmentProvider[]` |
| `pipeline/chunk-pipeline.ts` | Delete lines | Remove hardcoded `git.file.*` payload (345-360) |
| `api/ingest-facade.ts` | Small edit | Use registry instead of hardcoded GitEnrichmentProvider |

**Unchanged:** BaseIndexingPipeline, EnrichmentApplier, EnrichmentProvider interface, GitEnrichmentProvider, indexing.ts, reindexing.ts.

## Error handling

- `awaitCompletion` waits for all providers via `Promise.allSettled`
- One provider failure does not block others
- Errors logged per provider with `provider.key` prefix

## Testing

- Adapt existing coordinator tests for `providers[]`
- New test: coordinator with two mock providers — parallel prefetch, onChunksStored, awaitCompletion
- Verify ChunkPipeline payload no longer contains `git.file.*`
- Existing enrichment-await integration tests should pass (single git provider in array)
