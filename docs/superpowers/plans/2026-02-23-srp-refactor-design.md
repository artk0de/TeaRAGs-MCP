# SRP Refactoring: Domain Decomposition

## Problem

`src/index.ts` (428 lines) violates Single Responsibility Principle with 6
distinct responsibilities:

1. Environment variable parsing and validation
2. Ollama availability health-check
3. Dependency initialization (DI wiring)
4. MCP server configuration
5. Stdio transport setup
6. Full HTTP server (Express, rate-limiter, middleware, shutdown)

Additionally, `src/tools/search.ts` has 90% duplicated logic between
`semantic_search` and `hybrid_search` handlers, and `src/tools/code.ts`
duplicates enrichment status formatting in two tool handlers.

## Solution: Domain Folder Structure

### New Files (from index.ts decomposition)

```
src/
  index.ts                    # Thin entry-point: import bootstrap, call main()
  config/
    env.ts                    # Parse ALL env vars -> AppConfig type
    validate.ts               # Validate API keys, ports, provider names
  providers/
    ollama-check.ts           # checkOllamaAvailability()
  server/
    factory.ts                # createApp(): init Qdrant, embeddings, CodeIndexer, MCP server
  transport/
    stdio.ts                  # startStdioServer(server)
    http.ts                   # startHttpServer(createServerFn, config): Express + middleware + shutdown
```

### New Files (tools deduplication)

```
src/tools/
  formatters/
    enrichment.ts             # formatEnrichmentStatus(status, codeIndexer, path) -> string
    search-pipeline.ts        # executeSearchPipeline(params) -> ToolResult
```

### Data Flow

```
index.ts
  -> config/env.ts            parseAppConfig()
  -> config/validate.ts       validateConfig(config)
  -> providers/ollama-check   checkOllamaAvailability(config)
  -> server/factory.ts        createApp(config) -> { server, qdrant, embeddings, codeIndexer }
  -> transport/stdio.ts       OR
  -> transport/http.ts        (depending on config.transportMode)
```

### Key Types

```typescript
// config/env.ts
interface AppConfig {
  qdrantUrl: string;
  qdrantApiKey?: string;
  embeddingProvider: string;
  transportMode: "stdio" | "http";
  httpPort: number;
  requestTimeoutMs: number;
  promptsConfigFile: string;
  code: CodeConfig;
}

// server/factory.ts
interface AppContext {
  server: McpServer;
  qdrant: QdrantManager;
  embeddings: EmbeddingProvider;
  codeIndexer: CodeIndexer;
}
```

### Tools Deduplication

#### `formatters/enrichment.ts`

Extracts identical enrichment status formatting from `code.ts` lines 40-73 and
192-225.

```typescript
export async function formatEnrichmentStatus(
  enrichmentStatus: string | undefined,
  enrichmentDurationMs: number | undefined,
  codeIndexer: CodeIndexer,
  path: string,
): Promise<string>;
```

#### `formatters/search-pipeline.ts`

Extracts shared search logic from `search.ts` (semantic_search + hybrid_search).

```typescript
export async function resolveAndValidateCollection(
  qdrant: QdrantManager,
  collection?: string,
  path?: string,
): Promise<{ collectionName: string } | { error: ToolResult }>;

export function applyPostProcessing(
  results: SearchResult[],
  options: { pathPattern?: string; rerank?: RerankMode; limit: number },
): SearchResult[];

export function formatSearchResults(
  results: SearchResult[],
  metaOnly?: boolean,
): ToolResult;
```

## What Does NOT Change

- `src/code/indexer.ts` — already a clean facade (94 lines)
- `src/tools/collection.ts` — focused on collection CRUD
- `src/tools/document.ts` — focused on document operations
- `src/tools/schemas.ts` — moderate concern, deferred to separate PR
- All existing tests remain valid (behavior unchanged)

## Risks

- Import paths change across the project — tests may need path updates
- HTTP transport tests reference index.ts internals — may need adjustment
- The refactoring is purely structural — zero behavioral changes

## Success Criteria

- `src/index.ts` < 30 lines
- No file in new structure > 180 lines
- All existing tests pass without behavioral changes
- No duplicated code blocks > 10 lines
