# Thin MCP Layer — Design

## Goal

MCP layer becomes a thin mapping: schema → App call → MCP response. All business
logic moves to api/ and domain modules.

## Architecture

```
MCP                          ← Schema (Zod), params → App call, format response
  ↓
api/                         ← Public API: App factory, validation, resolve, metaOnly,
  ↓                            collection CRUD, document ops
explore/ ingest/ trajectory/ ← Domain: strategies, reranker, indexing pipeline, signals
```

## api/ — Public API

### Factory

`createApp(config: AppConfig): App` — creates Qdrant, Embeddings, all domain
modules. Replaces current bootstrap/factory.ts DI creation.

### App interface

```typescript
interface App {
  // Search (unified: semantic_search, hybrid_search, rank_chunks)
  search(request: SearchRequest): Promise<SearchResult[]>;

  // Indexing
  indexCodebase(request: IndexRequest): Promise<IndexStats>;
  reindexChanges(request: ReindexRequest): Promise<ChangeStats>;
  getIndexStatus(path: string): Promise<IndexStatus>;
  clearIndex(path: string): Promise<void>;

  // Collections
  createCollection(request: CreateCollectionRequest): Promise<CollectionInfo>;
  listCollections(): Promise<CollectionInfo[]>;
  getCollectionInfo(name: string): Promise<CollectionInfo>;
  deleteCollection(name: string): Promise<void>;

  // Documents
  addDocuments(request: AddDocumentsRequest): Promise<void>;
  deleteDocuments(request: DeleteDocumentsRequest): Promise<void>;

  // Schema descriptors (for MCP schema generation)
  getAvailablePresets(): string[];
  getFilterParams(): FilterParamDescriptor[];
}
```

All methods return typed domain objects. api/ does not know about MCP protocol.

### search() pipeline

1. Validate + resolve collection (path → collectionName)
2. Factory method → strategy (vector/hybrid/scroll based on params)
3. explore/ executes strategy + postprocess
4. metaOnly filtering (api/ knows about essential fields, overlay mask)
5. Drift warning attached to response

### metaOnly

`metaOnly` is a business parameter passed in `SearchRequest`. api/ returns
already-filtered results — MCP does not know about overlay, essential fields, or
payload structure.

### Schema descriptors

api/ exports plain descriptors (preset names, filter param definitions). MCP
builds Zod schemas from them. api/ does not depend on Zod or MCP SDK.

## explore/ — Domain: acquire + rerank

### Strategy pattern

```typescript
interface SearchStrategy {
  execute(collection: string, request: SearchRequest): Promise<RawResult[]>;
}

class VectorSearchStrategy   // embed → qdrant.search
class HybridSearchStrategy   // embed + BM25 → qdrant.hybridSearch
class ScrollRankStrategy     // scroll by payload field
```

Factory method in explore/ selects strategy based on request params (query
present → vector/hybrid, no query → scroll).

### PostProcess

Common for all strategies: pathPattern filter, rerank, groupBy, offset/limit.

## ingest/ — Domain: indexing pipeline only

Chunking, embedding, enrichment coordination. No collection CRUD, no document
ops. Contains: IndexPipeline, ReindexPipeline, StatusModule,
EnrichmentCoordinator. Also: resolveCollectionName, validatePath,
computeCollectionStats.

## MCP — Thin handlers

### Structure

- `mcp/tools/explore.ts` — semantic_search, hybrid_search, rank_chunks (was
  search.ts)
- `mcp/tools/collection.ts` — create, list, info, delete (thin)
- `mcp/tools/document.ts` — add, delete (thin)
- `mcp/tools/ingest.ts` — index_codebase, reindex_changes, get_index_status,
  clear_index
- `mcp/tools/schemas.ts` — Zod schemas, reads descriptors from App

### Handler pattern

```typescript
server.registerTool("semantic_search", { inputSchema }, async (params) => {
  const results = await app.search({ ...params });
  return formatMcpResponse(results);
});
```

### Shared formatter

`formatMcpResponse(data)` →
`{ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] }`

### Imports

MCP imports ONLY from api/ + types from contracts/ (for type safety via DIP).

## What moves where

| From                                      | To                     | What                                          |
| ----------------------------------------- | ---------------------- | --------------------------------------------- |
| `mcp/tools/search.ts` logic               | `api/` + `explore/`    | resolve, embed, search, rerank                |
| `mcp/tools/formatters/search-pipeline.ts` | `api/`                 | metaOnly, overlay filtering, essential fields |
| `mcp/tools/collection.ts` logic           | `api/`                 | collection CRUD (qdrant calls)                |
| `mcp/tools/document.ts` logic             | `api/`                 | add/delete docs (embed + qdrant)              |
| `bootstrap/factory.ts` DI creation        | `api/createApp()`      | QdrantManager, EmbeddingProvider              |
| `mcp/tools/search.ts`                     | `mcp/tools/explore.ts` | rename                                        |

## Out of scope

- trajectory/ — no changes
- contracts/ types — no changes
- Reranker internals — no changes (only add strategies to explore/)
- MCP tool names — stay the same (semantic_search, hybrid_search, etc.)
