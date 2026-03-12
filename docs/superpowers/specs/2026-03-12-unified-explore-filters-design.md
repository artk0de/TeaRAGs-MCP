# Unified Explore Filters & Type Consolidation

**Date:** 2026-03-12 **Branch:** plan/thin-mcp-layer **Status:** Approved

## Problem

4 search MCP tools have inconsistent filter handling:

1. `semantic_search`, `hybrid_search`, `rank_chunks` — accept raw Qdrant filter
   only
2. `search_code` — accepts typed params (author, minAgeDays, fileTypes...) via
   ExploreModule
3. `rank_chunks` silently mutates user filter (excludeDocumentation adds
   must_not)
4. Basic filters (fileTypes, documentationOnly) hardcoded in ExploreModule,
   duplicating FilterDescriptors from static trajectory
5. ExploreModule hardcodes "chunk" level for registry.buildFilter()

Additionally, response/result types are inconsistent:

- `SearchResult` in contracts duplicates `ExploreResult` in strategies (differ
  only in id required vs optional)
- `SearchCodeResult` extracts payload fields into top-level props — presentation
  concern, not domain
- `SearchResponse` / `SearchCodeResponse` are structurally identical wrappers

## Design Decisions

1. **All 4 tools get typed filter params + raw Qdrant filter** (Option C)
2. **Typed params → must conditions, appended to raw filter's must array**
   (Option 2)
3. **excludeDocumentation becomes a FilterDescriptor with must_not support**
   (Option A — extend FilterDescriptor)
4. **Two separate filter params: isDocumentation (must, include only docs) and
   excludeDocumentation (must_not, exclude docs)**
5. **Single ExploreResult for all endpoints** — MCP layer handles presentation
   formatting
6. **Single ExploreResponse** — no generic, all endpoints return same type
7. **Request DTOs keep specific names** — SemanticSearchRequest,
   HybridSearchRequest, RankChunksRequest stay; SearchCodeRequest →
   ExploreCodeRequest
8. **ExploreModule deleted** — search_code migrated to strategy pipeline

## Architecture

### Filter Flow (unified for all 4 tools)

```
MCP tool handler
  ├── typed params (author, minAgeDays, fileTypes, excludeDocumentation...)
  └── raw filter (Qdrant native)
        │
        ▼
ExploreFacade.buildMergedFilter(typedParams, rawFilter, level)
  ├── registry.buildFilter(typedParams, level) → { must: [...], must_not: [...] }
  └── merge: append typed conditions to raw filter
        │
        ▼
ExploreContext.filter (single merged Qdrant filter)
        │
        ▼
Strategy.execute(ctx) → ExploreResult[]
```

### FilterDescriptor Extension

Current:

```typescript
toCondition: (value: unknown, level?: FilterLevel) => QdrantFilterCondition[];
// Always goes into must
```

New:

```typescript
toCondition: (value: unknown, level?: FilterLevel) => FilterConditionResult;

interface FilterConditionResult {
  must?: QdrantFilterCondition[];
  must_not?: QdrantFilterCondition[];
}
```

### Filter Merge Logic (in facade)

1. `registry.buildFilter(typedParams, level)` →
   `{ must: [...], must_not: [...] }`
2. If raw filter exists: append typed `must` to `filter.must`, append typed
   `must_not` to `filter.must_not`
3. If raw filter absent: return typed filter (or undefined if empty)
4. `should` from raw filter preserved untouched

### New FilterDescriptors

Static trajectory (`static/filters.ts`):

- `isDocumentation` (boolean) →
  `must: [{ key: "isDocumentation", match: { value: true } }]`
- `excludeDocumentation` (boolean) →
  `must_not: [{ key: "isDocumentation", match: { value: true } }]`
- `fileExtension` — already exists
- `language` — already exists
- `chunkType` — already exists

Git trajectory (`git/filters.ts`):

- Already has: author, modifiedAfter, modifiedBefore, minAgeDays, maxAgeDays,
  minCommitCount, taskId

### searchCodeTyped → exploreCode Migration

Current path: `searchCodeTyped` → `searchCode` → `new ExploreModule(...)` →
separate pipeline

New path (unified):

1. Facade receives `ExploreCodeRequest` (path, query, author, minAgeDays,
   fileTypes...)
2. `resolveCollection(path)` → collectionName
3. Typed params → `registry.buildFilter()` → merged Qdrant filter
4. Auto-detect hybrid: `collectionInfo.hybridEnabled` → choose vectorStrategy /
   hybridStrategy
5. `executeExplore(strategy, ctx, path)` — same pipeline as other 3 tools
6. Return `ExploreResponse` (ExploreResult[] with payload, no field extraction)

MCP tool `search_code` handler extracts content/filePath/startLine from payload
when formatting response.

### Type Consolidation

**Deleted:**

- `SearchResult` (contracts/types/app.ts) — replaced by `ExploreResult` from
  strategies/types.ts
- `SearchResponse` (contracts/types/app.ts) — replaced by `ExploreResponse`
- `SearchCodeResult` (contracts/types/app.ts) — MCP layer extracts from payload
- `SearchCodeResponse` (contracts/types/app.ts) — replaced by `ExploreResponse`
- `CodeSearchResult` (core/types.ts) — legacy
- `SearchOptions` (core/types.ts) — legacy
- `ExploreCodeConfig` (core/types.ts) — replaced by auto-detect + request
  defaults

**New/Renamed:**

- `ExploreResponse` =
  `{ results: ExploreResult[], driftWarning: string | null }`
- `ExploreCodeRequest` (was SearchCodeRequest)
- `ExploreContext` (was SearchContext) — already done
- `FilterConditionResult` =
  `{ must?: QdrantFilterCondition[], must_not?: QdrantFilterCondition[] }`

**Kept as-is:**

- `ExploreResult` (strategies/types.ts) — single result type, id optional
- `SemanticSearchRequest`, `HybridSearchRequest`, `RankChunksRequest` —
  tool-specific DTOs
- `ExploreStrategy`, `BaseExploreStrategy` — already renamed

### ExploreModule Deletion

After migration, delete:

- `src/core/explore/explore-module.ts` (148 lines)
- `ExploreCodeConfig` from `src/core/types.ts`
- `SearchOptions` from `src/core/types.ts`
- `CodeSearchResult` from `src/core/types.ts`
- `config.exploreCode` from bootstrap config
- ExploreModule mock from test files

## Files Affected

### Modify

- `src/core/contracts/types/provider.ts` — FilterConditionResult, update
  FilterDescriptor
- `src/core/contracts/types/app.ts` — ExploreResponse, ExploreCodeRequest,
  remove SearchResult/SearchCodeResult/SearchResponse/SearchCodeResponse
- `src/core/trajectory/static/filters.ts` — add isDocumentation,
  excludeDocumentation FilterDescriptors
- `src/core/trajectory/index.ts` — registry.buildFilter() returns { must,
  must_not }
- `src/core/api/explore-facade.ts` — buildMergedFilter(), exploreCode(), remove
  searchCode/searchCodeTyped
- `src/core/api/app.ts` — App interface, re-exports
- `src/core/api/create-app.ts` — wire exploreCode
- `src/core/explore/strategies/scroll-rank.ts` — remove excludeDocumentation
  (now via typed param)
- `src/mcp/tools/code.ts` — pass typed params, format ExploreResult payload →
  response fields
- `src/mcp/tools/explore.ts` — pass typed params where applicable
- `src/mcp/tools/schemas.ts` — add typed filter params to all tool schemas
- `src/bootstrap/factory.ts` — remove ExploreCodeConfig
- `src/bootstrap/config/index.ts` — remove exploreCode config
- `src/core/types.ts` — remove ExploreCodeConfig, SearchOptions,
  CodeSearchResult

### Delete

- `src/core/explore/explore-module.ts`

### Tests (update)

- `tests/core/api/explore-facade.test.ts`
- `tests/core/api/explore-facade-expanded.test.ts`
- `tests/core/api/create-app.test.ts`
- `tests/core/explore/explore-module.test.ts` (delete or migrate)
- `tests/core/explore/strategies/scroll-rank.test.ts` — remove
  excludeDocumentation tests
- `tests/integration/integration.test.ts`
- `tests/core/ingest/indexer.test.ts`
