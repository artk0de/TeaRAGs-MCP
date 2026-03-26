# find_symbol Design

**Date:** 2026-03-26 **Status:** Approved **Beads:** tea-rags-mcp-zvyc **Epic:**
tea-rags-mcp-l26 (codegraph)

## Problem

There is no fast, non-embedding symbol lookup in tea-rags. Finding a symbol by
name requires `semantic_search` + `symbolId` filter, which involves vector
embedding and scoring overhead. Agents need a direct "go to definition" tool
that resolves symbols instantly via Qdrant scroll.

## Design

### MCP Tool: `find_symbol`

```typescript
find_symbol({
  symbol: string,       // required — symbolId or partial name
  path?: string,        // codebase path (auto-resolves collection)
  collection?: string,  // or direct collection name
  language?: string,    // disambiguation for polyglot codebases
  pathPattern?: string, // glob scope (picomatch)
  metaOnly?: boolean,   // strip content — existence check
  rerank?: string | { custom: Record<string, number> }, // attach ranking overlay
})
```

**No vector search.** Uses Qdrant scroll with `symbolId` text match filter. No
embedding. Optional reranking attaches ranking overlay with git signals per
chunk.

### Matching

Qdrant `match.text` on `symbolId` field (text index already exists from
`tea-rags-mcp-c038f2e`). Partial match by tokenized segments:

- `"Reranker"` matches `Reranker`, `Reranker.score`, `Reranker.getPresetNames`
- `"score"` matches `Reranker.score`, `ScoringEngine.score`
- `"Reranker.score"` matches exactly `Reranker.score`

### Response Strategies

Return type is `ExploreResponse` (same as all other search tools). Two
strategies based on the matched chunk type:

#### Strategy 1: Function/Interface (merge chunks)

When matched chunks share the same `symbolId` and `relativePath` (a single
symbol split across chunks by the chunker):

- **Merge** all chunks into one result, content ordered by `startLine`
- **Git stats**: file-level (chunk-level stats lose meaning when merged)
- **Extra payload fields**:
  - `mergedChunkIds: string[]` — UUIDs of source chunks
  - `startLine` / `endLine` — combined line range (reuses existing payload
    shape)

#### Strategy 2: Class (outline + members)

When matched chunk has `chunkType: "class"`:

- **Content**: the class chunk only (signature, constructor, properties)
- **Members**: collect all chunks where `parentName` matches the class name
  (same `relativePath`), return as `members: string[]` of symbolId values
- **Git stats**: file-level

### Disambiguation

Multiple symbols may match a partial query (e.g., `"score"` matches in several
files). All matches are returned as separate results in the `ExploreResponse`,
ordered by:

1. Exact symbolId match first
2. Then by `relativePath` alphabetically

No limit cap — return all matches (symbol lookup should never produce hundreds
of results for a reasonable query).

### DTO

```typescript
// In dto/explore.ts
export interface FindSymbolRequest extends CollectionRef {
  symbol: string;
  language?: string;
  pathPattern?: string;
}
```

Reuses `CollectionRef` for `path`/`collection`. Does NOT extend
`TypedFilterParams` — only `language` and `pathPattern` are exposed as explicit
fields. No `filter`, `rerank`, `metaOnly`, `level`, `offset`, or `limit`.

### Architecture (wiring chain)

| Layer         | File                                     | Change                               |
| ------------- | ---------------------------------------- | ------------------------------------ |
| DTO           | `api/public/dto/explore.ts`              | Add `FindSymbolRequest`              |
| DTO barrel    | `api/public/dto/index.ts`                | Re-export `FindSymbolRequest`        |
| App interface | `api/public/app.ts`                      | Add `findSymbol` method              |
| App factory   | `api/public/app.ts` `createApp()`        | Wire to `ExploreFacade.findSymbol()` |
| Facade        | `api/internal/facades/explore-facade.ts` | Add `findSymbol()` method            |
| Domain logic  | `domains/explore/symbol-resolve.ts`      | New file: merge/outline strategies   |
| MCP tool      | `mcp/tools/`                             | Register `find_symbol` tool          |
| MCP schema    | `mcp/tools/schemas.ts`                   | Add Zod schema for `find_symbol`     |

### Domain Logic: `symbol-resolve.ts`

New file in `domains/explore/`. Pure functions, no Qdrant dependency:

```typescript
// Input: raw scroll results (chunks matching symbolId)
// Output: merged/outlined ExploreResponse results

interface SymbolResolveResult {
  results: SearchResult[];
}

// Decides strategy per group of chunks with same symbolId + relativePath
function resolveSymbols(chunks: ScrollChunk[]): SymbolResolveResult;

// Strategy 1: merge function/interface chunks
function mergeChunks(chunks: ScrollChunk[]): SearchResult;

// Strategy 2: outline class with member list
function outlineClass(
  classChunk: ScrollChunk,
  memberChunks: ScrollChunk[],
): SearchResult;
```

### ExploreFacade.findSymbol() Flow

```
1. resolveAndGuard(collection, path)       — validate collection exists
2. Build Qdrant filter:
   - must: [{ key: "symbolId", match: { text: symbol } }]
   - optional: language filter, pathPattern filter
3. Qdrant scroll (no vector, no embedding)  — fetch all matching chunks
4. Group by (symbolId, relativePath)
5. Per group: apply merge or outline strategy
6. Sort: exact match first, then alphabetical by path
7. Attach file-level git stats from payload
8. Return ExploreResponse { results, driftWarning }
```

### Payload Shape (result)

For merged function:

```json
{
  "id": "first-chunk-uuid",
  "score": 1.0,
  "payload": {
    "content": "merged code...",
    "relativePath": "src/core/domains/explore/reranker.ts",
    "startLine": 45,
    "endLine": 78,
    "symbolId": "Reranker.score",
    "chunkType": "function",
    "mergedChunkIds": ["uuid-1", "uuid-2"],
    "language": "typescript",
    "git": { "file": { ... } }
  }
}
```

For class outline:

```json
{
  "id": "class-chunk-uuid",
  "score": 1.0,
  "payload": {
    "content": "class declaration code...",
    "relativePath": "src/core/domains/explore/reranker.ts",
    "startLine": 10,
    "endLine": 25,
    "symbolId": "Reranker",
    "chunkType": "class",
    "members": ["Reranker.score", "Reranker.getPresetNames", "Reranker.rerank"],
    "language": "typescript",
    "git": { "file": { ... } }
  }
}
```

## What We Do NOT Build

- No vector search — scroll + filter only
- No new response DTO — reuses `ExploreResponse`
- No reranking — results are exact matches, not scored by signals
- No usages/callers/implementations — deferred to code-graph epic scope
- No cross-file class resolution — class + members must be in same file
