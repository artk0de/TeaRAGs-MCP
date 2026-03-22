# Embedding Model Guard

## Problem

Incremental reindex and search operations silently use the wrong embedding model
when `EMBEDDING_MODEL` config changes between sessions. Vectors from different
models are incompatible — search quality degrades without any error.

The embedding model name is not stored anywhere in the collection metadata.

## Solution

`EmbeddingModelGuard` — a shared in-memory cache that tracks which embedding
model was used for each collection. On first access, lazily reads the model name
from the Qdrant indexing marker. On mismatch, throws a typed error. On missing
marker, backfills.

## Design

### EmbeddingModelGuard

**File:** `src/core/infra/embedding-model-guard.ts`

```typescript
class EmbeddingModelGuard {
  // Map<collectionName, modelName | null>
  // null = read from Qdrant, no model stored (legacy, already backfilled)
  // undefined (key absent) = not yet read
  private cache = new Map<string, string | null>();

  constructor(
    private readonly qdrant: QdrantManager,
    private readonly currentModel: string,
    private readonly dimensions: number,
  );

  /** Check model match. Throws on mismatch. Backfills if missing. */
  async ensureMatch(collectionName: string): Promise<void>;

  /** Record model for new collection (full index, create_collection) */
  recordModel(collectionName: string): void;

  /** Invalidate cache entry (force reindex, clear_index) */
  invalidate(collectionName: string): void;
}
```

### ensureMatch() flow

1. Key in cache → compare with `currentModel`
2. Not in cache → read `INDEXING_METADATA_ID` point from Qdrant
3. Point exists + `embeddingModel` field present → compare, cache
4. Point exists + `embeddingModel` nil → **backfill**: setPayload
   `{ embeddingModel }` on marker, cache
5. Point does not exist → **backfill**: create marker point with zero vector +
   `{ _type: "indexing_metadata", indexingComplete: true, embeddingModel }`,
   cache

On mismatch at steps 1 or 3: throw `EmbeddingModelMismatchError`.

### EmbeddingModelMismatchError

**File:** `src/core/infra/errors.ts`

```typescript
export class EmbeddingModelMismatchError extends TeaRagsError {
  constructor(expected: string, actual: string) {
    super({
      code: "INFRA_EMBEDDING_MODEL_MISMATCH",
      message: `Embedding model mismatch: collection indexed with "${expected}", current config uses "${actual}"`,
      hint:
        `Either:\n` +
        `1. Fix EMBEDDING_MODEL to "${expected}"\n` +
        `2. Force re-index: index_codebase with forceReindex=true`,
      httpStatus: 409,
    });
  }
}
```

### Call sites

| Operation         | Class         | Method                       | Guard call                                            |
| ----------------- | ------------- | ---------------------------- | ----------------------------------------------------- |
| Auto-reindex      | IngestFacade  | `indexCodebase()`            | `ensureMatch()` before `reindexChanges()`             |
| Explicit reindex  | IngestFacade  | `reindexChanges()`           | `ensureMatch()` at start                              |
| Full index        | IndexPipeline | `storeIndexingMarker(false)` | writes model to marker payload                        |
| Force reindex     | IngestFacade  | `indexCodebase(force)`       | `invalidate()` + `recordModel()` after new collection |
| Create collection | CollectionOps | `create()`                   | `recordModel()` after creation                        |
| Add documents     | DocumentOps   | `add()`                      | `ensureMatch()` before embed                          |
| Search/explore    | ExploreFacade | all search methods           | `ensureMatch()` before query embed                    |
| Clear index       | IngestFacade  | `clearIndex()`               | `invalidate()`                                        |

### Wiring

**File:** `src/bootstrap/factory.ts`

```typescript
const modelGuard = new EmbeddingModelGuard(
  qdrant,
  embeddings.getModel(),
  embeddings.getDimensions(),
);
// Pass to IngestFacade, ExploreFacade, CollectionOps, DocumentOps
```

### Marker payload change

`storeIndexingMarker(complete=false)` adds
`embeddingModel: embeddings.getModel()` to the initial marker payload. No change
to `complete=true` path (setPayload preserves existing fields).

## Files to modify

| File                                                  | Change                                              |
| ----------------------------------------------------- | --------------------------------------------------- |
| `src/core/infra/embedding-model-guard.ts`             | New: guard class                                    |
| `src/core/infra/errors.ts`                            | Add `EmbeddingModelMismatchError`                   |
| `src/core/contracts/errors.ts`                        | Add error code                                      |
| `src/core/domains/ingest/pipeline/indexing-marker.ts` | Add `embeddingModel` to payload                     |
| `src/core/api/internal/facades/ingest-facade.ts`      | Inject guard, call `ensureMatch()` / `invalidate()` |
| `src/core/api/internal/facades/explore-facade.ts`     | Inject guard, call `ensureMatch()`                  |
| `src/core/api/internal/ops/collection-ops.ts`         | Inject guard, call `recordModel()`                  |
| `src/core/api/internal/ops/document-ops.ts`           | Inject guard, call `ensureMatch()`                  |
| `src/bootstrap/factory.ts`                            | Create guard, pass to facades/ops                   |
| `src/core/domains/ingest/pipeline/status-module.ts`   | Read `embeddingModel` from marker                   |
| `src/core/types.ts`                                   | Add `embeddingModel?` to `IndexStatus`              |
| `src/core/api/public/dto/ingest.ts`                   | Same DTO update                                     |

## Verification

1. `npm run build && npx vitest run`
2. Full index → `get_index_status` → `embeddingModel` field present
3. Change `EMBEDDING_MODEL` → `index_codebase` → `EmbeddingModelMismatchError`
4. Legacy collection (no model in marker) → `index_codebase` → backfill + pass
5. `create_collection` → `get_index_status` → model stored
6. Search with wrong model → `EmbeddingModelMismatchError`
