# Explore Facade GRASP Refactoring

## Problem

`explore-facade.ts` (403 lines) suffers from:

1. **Copypasta pipeline** across `semanticSearch`, `hybridSearch`, `rankChunks`
   — all repeat: resolve -> validate -> ensureStats -> execute -> postProcess ->
   metaOnly -> drift
2. **Duplicated code** — `HybridNotEnabledError` and `excludeDocumentation()`
   exist in both the facade and `explore/strategies/`
3. **Legacy `ExploreModule`** (148 lines) duplicates logic already extracted
   into strategies + post-process
4. **Scattered defaults** — fetch limits in 3 places (post-process,
   explore-facade inline, ExploreModule)
5. **metaOnly data injection** — facade stores `essentialTrajectoryFields` and
   imports `BASE_PAYLOAD_SIGNALS` instead of using TrajectoryRegistry

## Design

### Strategy Base Class with Shared Defaults

Strategies already exist in `explore/strategies/`. Refactor from interface to
abstract base class with shared defaults for vector-based searches:

```
BaseSearchStrategy (abstract)
  - injected: PayloadSignalDescriptors, essentialKeys (from registry via DI)
  - defaults: limit=5, metaOnly=false, computeFetchLimit(ctx)
  - abstract executeSearch(ctx): Promise<RawResult[]>
  - execute(ctx): applyDefaults(ctx) -> executeSearch(ctx) -> postProcess(glob, rerank, trim) -> applyMetaOnly
  │
  ├─ VectorSearchStrategy
  │    executeSearch: qdrant.search(embedding, fetchLimit, filter)
  │
  ├─ HybridSearchStrategy
  │    executeSearch: validate hybrid -> BM25 sparse -> qdrant.hybridSearch(...)
  │
  └─ ScrollRankStrategy (overrides applyDefaults)
       defaults: metaOnly=true, offset handling, excludeDocumentation, own fetchLimit
       executeSearch: resolve weights -> RankModule.rankChunks -> pathPattern -> offset
```

`semantic_search`, `hybrid_search`, and `search_code` share the same base
defaults. `rank_chunks` overrides `applyDefaults()`.

`SearchContext` carries `pathPattern` and `rerank` fields so that
`computeFetchLimit` in the base class can calculate overfetch correctly.

**metaOnly is a strategy concern.** Each strategy knows its default metaOnly
behavior (`ScrollRankStrategy` defaults to `metaOnly=true`, vector-based
strategies default to `false`). The base class applies `filterMetaOnly()` after
`executeSearch()` returns, using injected `PayloadSignalDescriptors` and
`essentialKeys` (passed via constructor/factory from the facade, which gets them
from TrajectoryRegistry). This respects the layer rule: explore/ doesn't import
from trajectory/, but receives the data through DI.

### Unified Pipeline in Facade

Replace the 3 copy-pasted method bodies with one shared pipeline method:

```typescript
private async executeExplore(
  request: { collection?: string; path?: string; /* common fields */ },
  strategy: SearchStrategy,
  buildContext: (collectionName: string) => Promise<SearchContext>,
): Promise<SearchResponse> {
  const { collectionName, path } = this.resolveCollection(request.collection, request.path);
  await this.validateCollectionExists(collectionName, path);
  await this.ensureStats(collectionName);

  const ctx = await buildContext(collectionName);
  const results = await strategy.execute(ctx); // includes metaOnly if applicable

  const searchResults = this.toSearchResults(results);
  const driftWarning = await this.checkDrift(path, collectionName);

  return { results: finalResults, driftWarning };
}
```

Public methods become 3-5 lines each — prepare `SearchContext` and call
`executeExplore`.

### Kill ExploreModule

`ExploreModule` (148 lines) is a legacy monolith that duplicates:

- Collection validation (facade already does this)
- Filter building (registry already does this)
- Hybrid vs vector decision (strategies already do this)
- Glob filtering + reranking (post-process already does this)
- Fetch limit computation (strategies will own this)

`searchCodeTyped` is rewritten to use the same pipeline: `VectorSearchStrategy`
(or `HybridSearchStrategy` if collection supports it) + trajectory filter
building via `registry.buildFilter()` + result mapping to `CodeSearchResult`.

The legacy `searchCode(path, query, options)` method is removed.
`searchCodeTyped` becomes the only search_code entry point.

**Hybrid vs vector decision for search_code**: currently `ExploreModule` reads
`config.enableHybridSearch` + checks `collectionInfo.hybridEnabled`. After
refactoring, the facade checks `collectionInfo.hybridEnabled` and picks the
appropriate strategy via `createSearchStrategy()`. The `enableHybridSearch`
config flag is removed — the decision is based solely on collection capability.

**`ExploreCodeConfig` simplification**: with `ExploreModule` gone,
`enableHybridSearch` is no longer needed (see above). `defaultSearchLimit` moves
to the base strategy defaults. `ExploreCodeConfig` may be removed entirely if no
other fields remain; the facade receives individual config values via DI.

**`FilterBuilder` type**: orphaned when `ExploreModule` is deleted. Not
preserved — the facade calls `registry.buildFilter()` directly (inline closure).

**`SearchOptions` type**: only consumed by `ExploreModule` and
`explore-facade.ts`. Removed when `ExploreModule` is deleted. `searchCodeTyped`
receives `SearchCodeRequest` (from `contracts/types/app.ts`) directly.

### metaOnly via TrajectoryRegistry

TrajectoryRegistry already exposes:

- `getAllPayloadSignalDescriptors()` -> `PayloadSignalDescriptor[]`
- `getEssentialPayloadKeys()` -> `string[]`

Facade gets these from registry at call time instead of storing them in
constructor params. Remove `essentialTrajectoryFields` constructor parameter and
`BASE_PAYLOAD_SIGNALS` import.

### Remove Duplicates

| Duplicate in facade       | Canonical location                                                   |
| ------------------------- | -------------------------------------------------------------------- |
| `HybridNotEnabledError`   | `explore/strategies/types.ts` (facade imports from barrel)           |
| `excludeDocumentation()`  | `explore/strategies/scroll-rank.ts` (facade copy deleted, not moved) |
| `CollectionRefError`      | keep in facade (facade-specific validation)                          |
| `CollectionNotFoundError` | keep in facade (facade-specific validation)                          |
| `UnknownPresetError`      | keep in facade (facade-specific validation)                          |

### Preset Resolution

Currently `rankChunks` in the facade manually calls `reranker.getPreset()` and
filters weights. This duplicates what `Reranker.rerank()` already does
internally. After refactoring, preset resolution is exclusively `Reranker`'s
responsibility — strategies and facade never resolve presets manually.

## Affected Files

| File                                         | Action                                                         |
| -------------------------------------------- | -------------------------------------------------------------- |
| `src/core/api/explore-facade.ts`             | Rewrite: ~150 lines, unified pipeline                          |
| `src/core/explore/explore-module.ts`         | Delete                                                         |
| `src/core/explore/strategies/types.ts`       | Change: interface -> abstract base class                       |
| `src/core/explore/strategies/vector.ts`      | Change: extend base class                                      |
| `src/core/explore/strategies/hybrid.ts`      | Change: extend base class                                      |
| `src/core/explore/strategies/scroll-rank.ts` | Change: extend base class, override defaults                   |
| `src/core/explore/strategies/factory.ts`     | Possibly update constructor args                               |
| `src/core/types.ts`                          | Remove `SearchOptions` and simplify/remove `ExploreCodeConfig` |
| `tests/core/api/explore-facade*.test.ts`     | Update for new API                                             |
| `tests/core/explore/explore-module.test.ts`  | Delete                                                         |
| `tests/core/explore/strategies/*.test.ts`    | Update for base class                                          |

## Constraints

- **Layer rules**: explore/ cannot import from trajectory/. Registry data is
  injected via facade (composition root).
- **Backward compatibility**: `App` interface does not change. MCP handlers do
  not change. Only internal wiring changes.
- **No new abstractions beyond base class**: no middleware chain, no pipeline
  builder. One abstract class, one shared method in facade.

## Result

- `explore-facade.ts`: ~403 -> ~150 lines
- `explore-module.ts`: deleted (148 lines)
- No copypasta in facade
- Defaults owned by strategies (Information Expert)
- metaOnly data from registry (Information Expert)
- Preset resolution only in Reranker (Information Expert)
- No duplicated errors or helpers
