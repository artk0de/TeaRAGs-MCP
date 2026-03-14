# find_similar — Design

## Problem

Currently, to explore code similar to a found chunk, users must re-embed and
re-search with text queries. There is no way to say "find more code like THIS
chunk" or "find code similar to this generated snippet but NOT like that other
pattern".

This forces a lossy round-trip: chunk content -> mental summary -> text query ->
embedding -> search. The original vector is never reused, and negative examples
cannot be expressed at all.

## Solution

New MCP tool **`find_similar`** using Qdrant's universal `query()` API with
`recommend` sub-query. Supports:

- Chunk IDs as positive/negative examples (Qdrant resolves vectors internally)
- Raw code blocks as positive/negative examples (embedded on-the-fly via
  EmbeddingProvider)
- Mix of both in a single query
- Reranking with all existing presets
- Standard filtering (Qdrant filter, pathPattern, fileExtensions)

## Schema

| Parameter             | Type                                               | Required | Default      | Description                                                 |
| --------------------- | -------------------------------------------------- | -------- | ------------ | ----------------------------------------------------------- |
| `positiveIds`         | `string[]`                                         | no\*     | `[]`         | Chunk IDs from previous search results to find similar code |
| `positiveCode`        | `string[]`                                         | no\*     | `[]`         | Raw code blocks to find similar code (embedded on-the-fly)  |
| `negativeIds`         | `string[]`                                         | no       | `[]`         | Chunk IDs to push results away from                         |
| `negativeCode`        | `string[]`                                         | no       | `[]`         | Raw code blocks to push results away from                   |
| `strategy`            | `"best_score" \| "average_vector" \| "sum_scores"` | no       | `best_score` | Qdrant recommend strategy                                   |
| `filter`              | `object`                                           | no       | --           | Qdrant native filter (must/should/must_not)                 |
| `pathPattern`         | `string`                                           | no       | --           | Glob pattern to filter results by file path                 |
| `fileExtensions`      | `string[]`                                         | no       | --           | Filter by file extensions (e.g. `[".ts", ".js"]`)           |
| `rerank`              | `string \| object`                                 | no       | `relevance`  | Rerank preset name or custom weights                        |
| `limit`               | `number`                                           | no       | `10`         | Max results to return                                       |
| `offset`              | `number`                                           | no       | `0`          | Offset for pagination                                       |
| `metaOnly`            | `boolean`                                          | no       | `false`      | Return metadata only (no content)                           |
| `path` / `collection` | `string`                                           | yes      | --           | Project path or collection name                             |

\*At least one `positiveIds` or `positiveCode` entry is required.

### Strategy descriptions

- **`best_score`** (default): Scores each candidate against every example
  independently, picks best match. Most flexible — works with mixed
  positive/negative, handles diverse examples well. Slightly slower (linear in
  number of examples). **Only strategy that supports negative-only queries**
  (zero positives).
- **`average_vector`**: Averages all positive vectors, subtracts negative.
  Single vector search — fastest. Best when positive examples are conceptually
  similar. **Requires at least one positive input.**
- **`sum_scores`**: Sums scores across all examples. Middle ground between
  `best_score` and `average_vector`. **Requires at least one positive input.**

## Architecture

### New Components

1. **`QdrantManager.query()`** — new method in
   `src/core/adapters/qdrant/client.ts`
   - Wraps `client.query()` from `@qdrant/js-client-rest`
   - Accepts: collection, recommend input (positive/negative as
     `VectorInput[]`), filter, limit, offset
   - Automatically sets `using: "dense"` when collection has named vectors
     (hybrid-enabled), same logic as existing `search()` method
   - Returns: `ExploreResult[]` after mapping from `QueryResponse.points`
     (Qdrant returns `{ points: ScoredPoint[] }`, mapped to internal type
     consistent with `search()` / `hybridSearch()`)
   - IDs from `positiveIds`/`negativeIds` are passed to Qdrant as-is — they are
     already normalized UUIDs from previous search results

2. **`SimilarSearchStrategy`** — new file
   `src/core/domains/explore/strategies/similar.ts`
   - Extends `BaseExploreStrategy`
   - **Per-request instantiation** (unlike
     VectorSearchStrategy/HybridSearchStrategy which are created once in
     ExploreFacade constructor). This is because the strategy needs per-request
     positive/negative inputs. Created in `ExploreFacade.findSimilar()`
     directly, not through the strategy factory.
   - Strategy type: `"similar"` (added to `ExploreStrategyType` union in
     `strategies/types.ts`)
   - In `executeExplore()`:
     1. Embed code blocks via `EmbeddingProvider.embedBatch()` →
        `EmbeddingResult[]`, extract `.embedding` from each
     2. Build positive array: `[...positiveIds, ...embeddedPositiveVectors]`
     3. Build negative array: `[...negativeIds, ...embeddedNegativeVectors]`
     4. Build Qdrant filter (merge user filter + fileExtensions)
     5. Call `QdrantManager.query()` with recommend sub-query
   - Reranking handled by `BaseExploreStrategy.postProcess()` — no extra work
   - pathPattern filtering handled by `BaseExploreStrategy.postProcess()` — no
     extra work

3. **`FindSimilarRequest` DTO** — new in `src/core/api/public/dto/explore.ts`
   - All parameters from the schema table above
   - Validation: at least one positive input required
   - Strategy validation: `average_vector`/`sum_scores` require at least one
     positive input
   - Re-export via `src/core/api/public/dto/index.ts` barrel

4. **`App.findSimilar()`** — new method in `src/core/api/public/app.ts`
   - Add method signature to `App` interface (Search category)
   - Wire in `createApp()`:
     `findSimilar: async (req) => deps.explore.findSimilar(req)`

5. **`ExploreFacade.findSimilar()`** — in
   `src/core/api/internal/facades/explore-facade.ts`
   - Creates `SimilarSearchStrategy` per-request with positive/negative inputs
   - Calls `strategy.execute()` (same pattern as other explore methods)
   - Returns `ExploreResponse` (same structure as other search tools)

6. **MCP tool registration** — in `src/mcp/tools/explore.ts`
   - Register `find_similar` tool with Zod schema
   - Handler: parse params → call `app.findSimilar()` → `formatMcpResponse()`

7. **Preset tool lists** — add `"find_similar"` to preset `tools[]` arrays and
   to `getSchemaDescriptors` tool list in `app.ts` so rerank presets are
   available for this tool

8. **Barrel exports** — update `src/core/domains/explore/index.ts`

### fileExtensions filter

`fileExtensions` parameter is converted to a Qdrant filter condition using the
existing `match: { any }` pattern (consistent with `StaticTrajectory` filters in
`trajectory/static/filters.ts`):

```typescript
// fileExtensions: [".ts", ".js"] becomes:
{ key: "fileExtension", match: { any: [".ts", ".js"] } }
```

This is merged into the `must` array of the final filter alongside any
user-provided filter conditions.

## Data Flow

```
MCP tool `find_similar` input
  |
Parse & validate (at least 1 positive required)
  |
App.findSimilar(FindSimilarRequest)
  |
ExploreFacade.findSimilar()
  +-- Validate collection exists
  +-- Load stats (cold-start, same as other tools)
  +-- Create SimilarSearchStrategy (per-request, with positive/negative inputs)
  +-- SimilarSearchStrategy.execute()
  |   +-- applyDefaults() -> calculate overfetch limit
  |   +-- executeExplore()
  |   |   +-- embedBatch(positiveCode + negativeCode) via EmbeddingProvider
  |   |   +-- Extract .embedding from each EmbeddingResult
  |   |   +-- Build positive: [...positiveIds, ...embeddedPositiveVectors]
  |   |   +-- Build negative: [...negativeIds, ...embeddedNegativeVectors]
  |   |   +-- Build Qdrant filter (merge user filter + fileExtensions)
  |   |   +-- QdrantManager.query(collection, {
  |   |   |     query: { recommend: { positive, negative, strategy } },
  |   |   |     using: "dense" (if hybrid-enabled),
  |   |   |     filter, limit: overfetchLimit, offset,
  |   |   |     with_payload: true
  |   |   |   })
  |   |   +-- Map QueryResponse.points -> ExploreResult[]
  |   +-- postProcess()
  |       +-- filterResultsByGlob(pathPattern)
  |       +-- Reranker.rerank() (if non-relevance preset)
  |       +-- Trim to limit
  |       +-- filterMetaOnly() (if metaOnly=true)
  +-- Map to SearchResult[]
  +-- Check drift
  |
formatMcpResponse(results) -> JSON string
```

### Qdrant query() call shape

```typescript
await client.query(collectionName, {
  query: {
    recommend: {
      positive: [
        "chunk-uuid-1",             // point ID (ExtendedPointId)
        [0.1, 0.2, ...],            // embedded code vector (number[])
      ],
      negative: [
        "chunk-uuid-2",
      ],
      strategy: "best_score",
    },
  },
  using: "dense",                    // named vector (hybrid-enabled collections)
  filter: { must: [...] },
  limit: 30,                        // overfetched
  offset: 0,
  with_payload: true,
  with_vector: false,
});
// Returns: { points: ScoredPoint[] }
```

## Error Handling

- **No positive inputs** → error: "At least one positiveIds or positiveCode
  entry is required"
- **Wrong strategy for input** → error if `average_vector`/`sum_scores` used
  with zero positives: "Strategy requires at least one positive input"
- **Invalid chunk ID** (not found in collection) → Qdrant returns error →
  propagate with clear message
- **Empty code block** in positiveCode/negativeCode → skip (don't embed empty
  strings)
- **Embedding failure** → propagate error with context about which code block
  failed

## Testing Strategy

- Unit tests for `SimilarSearchStrategy` (mock `QdrantManager.query`, mock
  `EmbeddingProvider.embedBatch`)
- Unit tests for `FindSimilarRequest` validation (positive required, strategy
  constraints)
- Unit tests for fileExtensions → filter conversion (`match: { any }`)
- Unit tests for positive/negative array building (IDs + embedded vectors merged
  correctly)
- Unit tests for `QdrantManager.query()` (correct `using` parameter, response
  mapping)
- Integration test via MCP tool (after server reconnect)

## Decisions

1. **`query()` over deprecated `recommend()`** — future-proof, supports MMR
   later.
2. **Separate params (`positiveIds`/`positiveCode`) over union types** — MCP
   schemas parse better with flat params, zero ambiguity for agents.
3. **`best_score` as default strategy** — more robust for diverse inputs, only
   strategy supporting negative-only queries.
4. **`filter` + `pathPattern` + `fileExtensions` (no git shorthand params)** —
   power tool for power users, Qdrant filter covers everything.
5. **Reranking included** — consistency with other explore tools, free via
   `BaseExploreStrategy`.
6. **`SimilarSearchStrategy`** (not `RecommendStrategy`) — avoids naming
   collision with Qdrant's `RecommendStrategy` type
   (`"average_vector" | "best_score" | "sum_scores"`).
7. **Per-request strategy instantiation** — unlike other strategies cached in
   constructor, `SimilarSearchStrategy` needs per-request positive/negative
   inputs. Created directly in `ExploreFacade.findSimilar()`, not through the
   factory.
8. **`embedBatch()` over sequential `embed()`** — batch embedding for multiple
   code blocks is more efficient.
9. **IDs passed as-is to Qdrant** — chunk IDs from search results are already
   normalized UUIDs, no re-normalization needed.
10. **`match: { any }` for fileExtensions** — follows existing pattern in
    `StaticTrajectory` filters, cleaner than `should` array construction.
