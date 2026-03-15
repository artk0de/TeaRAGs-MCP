# Scalar Quantization Design

## Goal

Enable int8 scalar quantization for Qdrant collections to reduce RAM usage ~4x.
Critical for embedded Qdrant on laptops with large codebases (100K+ chunks).

## Scope

- New env variable `QDRANT_QUANTIZATION_SCALAR=true` (default: `false`)
- Applied at collection creation time (`QdrantManager.createCollection`)
- No MCP tool parameters — config-only
- No migration for existing collections
- Only scalar (int8), no binary or product quantization

## Design

### Config Layer

**`src/core/contracts/types/config.ts`** — add field to `QdrantTuneConfig`:

```typescript
quantizationScalar: boolean;
```

**`src/bootstrap/config/schemas.ts`** — add Zod field to `qdrantTuneSchema`:

```typescript
quantizationScalar: booleanFromEnv,
```

`booleanFromEnv` defaults to `false` when env var is absent — matches the
desired default behavior.

**`src/bootstrap/config/parse.ts`** — add env mapping to `qdrantTuneInput`:

```typescript
quantizationScalar: env("QDRANT_QUANTIZATION_SCALAR"),
```

### QdrantManager

**`src/core/adapters/qdrant/client.ts`** — add optional parameter to
`createCollection()`:

```typescript
async createCollection(
  name: string,
  vectorSize: number,
  distance: "Cosine" | "Euclid" | "Dot" = "Cosine",
  enableSparse = false,
  quantizationScalar = false,
): Promise<void>
```

Extend the local `CollectionConfig` interface with optional
`quantization_config`. When `quantizationScalar=true`, add to config object:

```typescript
quantization_config: {
  scalar: {
    type: "int8",
    always_ram: true,
  },
}
```

`always_ram: true` keeps quantized vectors in RAM for fast search; original
vectors stay on disk for rescoring. This is the recommended Qdrant
configuration.

### Wiring

**`CollectionOps`** (`src/core/api/internal/ops/collection-ops.ts`):

Currently receives only `(qdrant, embeddings)` in constructor. Needs
`quantizationScalar: boolean` injected. Two options:

- Add `qdrantTune: QdrantTuneConfig` to constructor (future-proof for more
  tuning params)
- Add just `quantizationScalar: boolean`

Use the boolean directly — YAGNI. If more tuning params are needed later, we
refactor.

Constructor becomes:

```typescript
constructor(
  private readonly qdrant: QdrantManager,
  private readonly embeddings: EmbeddingProvider,
  private readonly quantizationScalar: boolean,
)
```

`create()` passes `this.quantizationScalar` to `this.qdrant.createCollection()`.

**`AppDeps`** (`src/core/api/public/app.ts`):

`CollectionOps` is instantiated inside `createApp(deps)` at line 98. Add
`quantizationScalar: boolean` to the `AppDeps` interface. `createApp()` passes
it to the `CollectionOps` constructor.

**`factory.ts`** (`src/bootstrap/factory.ts`):

`createApp(deps)` call gains
`quantizationScalar: zodConfig.qdrantTune.quantizationScalar` in the deps
object.

**`IndexPipeline`** (`src/core/domains/ingest/indexing.ts`):

Line 67 calls
`this.qdrant.createCollection(collectionName, vectorSize, "Cosine", this.config.enableHybridSearch)`.
The pipeline inherits from `BaseIndexingPipeline` which has `this.config` (type
`IngestCodeConfig`).

Add `quantizationScalar` to `IngestCodeConfig` — this config is already wired
through `IngestFacade` from `config.ingestCode` in factory.ts. Then pass it as
5th arg to `createCollection()`.

**`ReindexPipeline`**: uses `SyncPipeline` which calls `upsert`/`delete`, not
`createCollection`. No changes needed — reindex only modifies existing
collections.

### forceReindex Path

`IndexPipeline` deletes and recreates the collection when `forceReindex=true`
(lines 62-67). The new `createCollection` call already includes
`quantizationScalar`, so recreated collections get quantization automatically.

## Files Changed

| File                                          | Change                                                                     |
| --------------------------------------------- | -------------------------------------------------------------------------- |
| `src/core/contracts/types/config.ts`          | Add `quantizationScalar` to `QdrantTuneConfig`                             |
| `src/bootstrap/config/schemas.ts`             | Add Zod field to `qdrantTuneSchema`                                        |
| `src/bootstrap/config/parse.ts`               | Map env `QDRANT_QUANTIZATION_SCALAR` to `qdrantTuneInput`                  |
| `src/core/adapters/qdrant/client.ts`          | Add `quantizationScalar` param, extend local `CollectionConfig` interface  |
| `src/core/api/internal/ops/collection-ops.ts` | Inject `quantizationScalar` in constructor, pass to `createCollection`     |
| `src/core/api/public/app.ts`                  | Add `quantizationScalar` to `AppDeps`, pass to `CollectionOps` constructor |
| `src/bootstrap/factory.ts`                    | Pass `zodConfig.qdrantTune.quantizationScalar` in `createApp(deps)`        |
| `src/core/domains/ingest/indexing.ts`         | Pass `this.config.quantizationScalar` to `createCollection`                |
| `src/core/types.ts`                           | Add `quantizationScalar: boolean` to `IngestCodeConfig`                    |

## What Does NOT Change

- MCP tools (no new parameters)
- Search logic (Qdrant handles quantized search transparently)
- Existing collections (quantization only at creation time)
- Embedding pipeline (ONNX/Ollama produce same vectors)
- `ReindexPipeline` / `SyncPipeline` (no `createCollection` calls)

## Testing

- Unit test: `QdrantManager.createCollection` — when `quantizationScalar=true`,
  Qdrant client receives `quantization_config` with scalar int8
- Unit test: `QdrantManager.createCollection` — when `quantizationScalar=false`
  (default), no `quantization_config` in call
- Unit test: Zod schema parses `QDRANT_QUANTIZATION_SCALAR=true` correctly,
  defaults to `false` when absent
- Unit test: `CollectionOps.create()` threads `quantizationScalar` through to
  `QdrantManager.createCollection`
