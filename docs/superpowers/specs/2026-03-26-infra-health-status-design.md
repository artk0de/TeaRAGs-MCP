# Infrastructure Health in get_index_status

## Problems

### P1: No Ollama health visibility

`get_index_status` only checks Qdrant collection state. When Ollama is down,
agents discover it only when `search_code`/`semantic_search` fails with
`INFRA_OLLAMA_UNAVAILABLE` — too late to act proactively.

### P2: Error responses lack health context

When `OllamaUnavailableError` or `QdrantUnavailableError` is thrown, the MCP
error response shows only the failing service. Agent doesn't know the state of
OTHER services. E.g., Qdrant error says nothing about Ollama status.

### P3: Stale indexing marker never cleaned up

When pipeline crashes (infra unavailable, OOM, kill -9), the indexing marker
`indexingComplete=false` stays in the `_vN` collection forever.
`get_index_status` detects it as `stale_indexing` but never cleans up. Result:
every subsequent `get_index_status` returns `stale_indexing`, blocking normal
workflow.

## Solution

### S1: Add `infraHealth` to `IndexStatus`

Extend `IndexStatus` in `src/core/types.ts`:

```typescript
infraHealth?: {
  qdrant: { available: boolean; url: string };
  embedding: { available: boolean; provider: string; url?: string };
};
```

`IngestFacade.getIndexStatus()` probes both services before returning status. If
Qdrant is down, returns
`{ isIndexed: false, status: "unavailable", infraHealth }` instead of throwing.
If Qdrant is up but Ollama is down, returns normal index status + `infraHealth`
with embedding unavailable.

### S2: Health-aware error interceptor

Enhance `errorHandlerMiddleware` in `src/mcp/middleware/error-handler.ts`. When
catching `OllamaUnavailableError` or `QdrantUnavailableError`, run a quick
health probe of the OTHER service and append context to the error message:

```
[INFRA_OLLAMA_UNAVAILABLE] Ollama is not reachable at http://192.168.1.71:11434

Infrastructure status:
  Qdrant: available (http://192.168.1.71:6333)
  Embedding (ollama): unavailable

Hint: Start Ollama: open -a Ollama
```

This requires the middleware to have access to health probe functions. Pass them
via closure when creating the middleware (DI, not import).

### S3: Auto-cleanup stale markers in `getIndexStatus()`

In `StatusModule.getStatusFromCollection()`, when `isStale` is detected:

1. Delete the stale `_vN` collection
2. Check if an older completed version exists (alias target)
3. If yes: return status from the alias target (index is actually fine)
4. If no: return `{ isIndexed: false, status: "not_indexed" }` with a message
   that stale collection was cleaned up

This makes `get_index_status` self-healing: stale markers are transparently
cleaned, next `index_codebase` starts fresh.

## Design Details

### `EmbeddingProvider.checkHealth()`

Add to `src/core/adapters/embeddings/base.ts`:

```typescript
export interface EmbeddingProvider {
  embed: (text: string) => Promise<EmbeddingResult>;
  embedBatch: (texts: string[]) => Promise<EmbeddingResult[]>;
  getDimensions: () => number;
  getModel: () => string;
  checkHealth: () => Promise<boolean>;
}
```

Implementations:

| Provider | `checkHealth()`                                                       |
| -------- | --------------------------------------------------------------------- |
| Ollama   | `GET /api/tags` with 1s timeout (reuses probe from health-probe spec) |
| ONNX     | `return true` (local, always available)                               |
| OpenAI   | `return true` (no cheap health endpoint, errors caught at embed time) |
| Cohere   | `return true`                                                         |
| Voyage   | `return true`                                                         |

### `QdrantManager.checkHealth()`

Add to `src/core/adapters/qdrant/client.ts`:

```typescript
async checkHealth(): Promise<boolean> {
  try {
    await this.call(() => this.client.getCollections());
    return true;
  } catch {
    return false;
  }
}
```

### `IngestFacade.getIndexStatus()` changes

```typescript
async getIndexStatus(path: string): Promise<IndexStatus> {
  const qdrantHealthy = await this.qdrant.checkHealth();
  const embeddingHealthy = await this.embeddings.checkHealth();

  const infraHealth = {
    qdrant: { available: qdrantHealthy, url: this.qdrant.url },
    embedding: {
      available: embeddingHealthy,
      provider: this.embeddingProvider,  // "ollama", "onnx", etc.
      url: this.embeddingUrl,            // only for remote providers
    },
  };

  if (!qdrantHealthy) {
    return {
      isIndexed: false,
      status: "unavailable",
      infraHealth,
    };
  }

  const status = await this.status.getIndexStatus(path);
  return { ...status, infraHealth };
}
```

### `StatusModule` stale cleanup

In `getStatusFromCollection()`, after detecting `isStale`:

```typescript
if (isStale) {
  // Clean up stale versioned collection
  if (sourceCollection !== reportedName) {
    // It's a _vN collection — safe to delete
    await this.qdrant.deleteCollection(sourceCollection);
  }
  // Check if alias still points to a valid older version
  const aliasTarget = await this.getAliasTarget(reportedName);
  if (aliasTarget) {
    return this.getStatusFromCollection(aliasTarget, reportedName);
  }
  return {
    isIndexed: false,
    status: "not_indexed",
    collectionName: reportedName,
  };
}
```

### Error interceptor enhancement

`errorHandlerMiddleware` receives health probe functions via factory:

```typescript
export function createErrorHandler(healthProbes?: {
  checkQdrant: () => Promise<boolean>;
  checkEmbedding: () => Promise<boolean>;
  qdrantUrl?: string;
  embeddingProvider?: string;
}) { ... }
```

When catching infra errors, appends health context to the error message.

### MCP tool handler update

`get_index_status` handler formats `infraHealth` in the response:

```
Index status: indexed (1234 chunks)
Embedding model: unclemusclez/jina-embeddings-v2-base-code:latest

Infrastructure:
  Qdrant: available (http://192.168.1.71:6333)
  Embedding (ollama): unavailable — Start Ollama: open -a Ollama
```

### New `IndexStatus.status` value

Add `"unavailable"` to the union type — means Qdrant is down, index state
unknown.

## Files Changed

| File                                                | Change                                                         |
| --------------------------------------------------- | -------------------------------------------------------------- |
| `src/core/types.ts`                                 | Add `infraHealth` to `IndexStatus`, add `"unavailable"` status |
| `src/core/adapters/embeddings/base.ts`              | Add `checkHealth()` to `EmbeddingProvider`                     |
| `src/core/adapters/embeddings/ollama.ts`            | Implement `checkHealth()`                                      |
| `src/core/adapters/embeddings/onnx.ts`              | Implement `checkHealth()` → `true`                             |
| `src/core/adapters/embeddings/openai.ts`            | Implement `checkHealth()` → `true`                             |
| `src/core/adapters/embeddings/cohere.ts`            | Implement `checkHealth()` → `true`                             |
| `src/core/adapters/embeddings/voyage.ts`            | Implement `checkHealth()` → `true`                             |
| `src/core/adapters/qdrant/client.ts`                | Add `checkHealth()`                                            |
| `src/core/api/internal/facades/ingest-facade.ts`    | Wrap `getIndexStatus()` with health probes                     |
| `src/core/domains/ingest/pipeline/status-module.ts` | Auto-cleanup stale markers                                     |
| `src/mcp/middleware/error-handler.ts`               | Health-aware error context                                     |
| `src/mcp/tools/code.ts`                             | Format `infraHealth` in response                               |

## Testing

- `StatusModule`: stale marker → auto-cleanup → returns `not_indexed`
- `StatusModule`: stale marker on `_vN` with valid alias → cleanup `_vN`, return
  status from alias
- `IngestFacade.getIndexStatus()`: Qdrant down → `status: "unavailable"` with
  `infraHealth`
- `IngestFacade.getIndexStatus()`: Qdrant up, Ollama down → normal status +
  `infraHealth.embedding.available: false`
- `IngestFacade.getIndexStatus()`: both up → normal status + both healthy
- `errorHandlerMiddleware`: `OllamaUnavailableError` → response includes Qdrant
  health context
- `errorHandlerMiddleware`: `QdrantUnavailableError` → response includes
  embedding health context
- `OllamaEmbeddings.checkHealth()`: server alive → `true`
- `OllamaEmbeddings.checkHealth()`: server dead → `false`
- `QdrantManager.checkHealth()`: server alive → `true`
- `QdrantManager.checkHealth()`: server dead → `false`
