# Ollama Model Info Auto-Detection

## Problem

`INGEST_CHUNK_SIZE` and `EMBEDDING_DIMENSIONS` are configured manually. When
users set `chunkSize` too large for the model's context window (e.g.,
`nomic-embed-text` has only 2048 tokens), chunks silently exceed the context and
fail at embed time with `OllamaContextOverflowError`.

Ollama exposes model capabilities via `/api/show` — context length and embedding
dimensions. We should query this once and use it to auto-configure chunk limits
and vector dimensions.

## Design

### 1. Model Info Query

New method `OllamaEmbeddings.resolveModelInfo()` → calls `/api/show` once,
returns:

```typescript
interface OllamaModelInfo {
  model: string; // "nomic-embed-text"
  contextLength: number; // 2048 (tokens)
  dimensions: number; // 768
}
```

Extracted from `model_info` in Ollama response: `*.context_length` and
`*.embedding_length`.

### 2. Collection Metadata

Store `model_info` in the indexing marker (Qdrant point payload), alongside
existing `embeddingModel`:

```typescript
interface IndexingMarkerPayload {
  // existing fields...
  embeddingModel?: string;
  // new field
  modelInfo?: OllamaModelInfo;
}
```

**On first index:** query Ollama → store in marker. **On re-index:** read from
marker. If absent (legacy collection) → query Ollama → backfill.

### 3. Chunk Size Auto-Configuration

Token-to-char ratio: **3 chars/token** (conservative, safe for code and prose).

**`INGEST_CHUNK_SIZE` not set:**

```
chunkSize = contextLength × 3 × 0.8
```

80% safety margin for breadcrumbs, overlap, metadata.

| Model             | contextLength | Default chunkSize |
| ----------------- | ------------- | ----------------- |
| nomic-embed-text  | 2048          | 4915              |
| jina-v2-base-code | 8192          | 19660             |

**`INGEST_CHUNK_SIZE` set but exceeds model limit:**

```
maxAllowed = contextLength × 3
chunkSize = min(userChunkSize, maxAllowed)
```

Cap silently — no warning, no error.

**`INGEST_CHUNK_SIZE` within limit:** use as-is.

**`maxChunkSize` derived from `chunkSize`:** applies uniformly to ALL chunkers
(tree-sitter AST, markdown, character fallback). Any chunk exceeding
`maxChunkSize` goes through character fallback regardless of source.

### 4. Dimensions Auto-Detection

For Ollama provider: always use `modelInfo.dimensions` from `/api/show`. Ignore
`EMBEDDING_DIMENSIONS` config when Ollama provides it.

For other providers (ONNX, OpenAI, Cohere, Voyage): keep existing behavior with
`EMBEDDING_DIMENSIONS` config + static lookup.

### 5. Bootstrap Flow

```
IngestFacade.indexCodebase() / reindexChanges()
  ├─ Read marker from existing collection (if re-index)
  │   └─ marker.modelInfo exists? → use it
  │   └─ marker.modelInfo absent? → query Ollama
  ├─ No collection (first index)? → query Ollama
  ├─ Apply chunkSize limits based on contextLength
  ├─ Use dimensions for collection creation
  └─ Store modelInfo in marker
```

`resolveModelInfo()` is called from `IngestFacade` before chunker configuration,
not at bootstrap time. This keeps the bootstrap synchronous and delays the
network call until actually needed.

### 6. Files to Change

| File                                               | Change                                                             |
| -------------------------------------------------- | ------------------------------------------------------------------ |
| `adapters/embeddings/ollama.ts`                    | Add `resolveModelInfo()` method                                    |
| `adapters/embeddings/base.ts`                      | Add optional `resolveModelInfo()` to `EmbeddingProvider` interface |
| `domains/ingest/pipeline/indexing-marker-codec.ts` | Add `modelInfo` field to codec                                     |
| `api/internal/facades/ingest-facade.ts`            | Call `resolveModelInfo()`, apply chunkSize cap, pass dimensions    |
| `core/types.ts`                                    | Add `OllamaModelInfo` type to `IndexingMarkerPayload`              |

## Out of Scope

- Auto model info for non-Ollama providers (backlog item)
- Tokenizer-level validation (too complex, char-based approximation is
  sufficient)
- Dynamic chunkSize adjustment mid-pipeline
