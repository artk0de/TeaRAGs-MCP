# Sparse Vector Migration Design

**Date:** 2026-03-22 **Status:** Draft **Scope:** Auto-migrate sparse vectors on
schema upgrade and hybrid enablement

## Problem

BM25 sparse vectors are generated at indexing time by a stateless tokenizer
(`generateSparseVector()`). When the tokenizer changes (e.g., `feb7f14` — code
tokenizer, feature hashing, TF-only), existing collections retain stale sparse
vectors. `reindex_changes` only generates new sparse vectors for changed files —
unchanged chunks keep old vectors forever.

Additionally, if a user enables `enableHybrid=true` in config after initial
indexing, existing collections have no sparse vectors at all. Currently the only
fix is `forceReindex` — full re-indexing from scratch.

## Default change

As part of this work, `enableHybrid` default changes from `false` to `true`.
With auto-migration this is no longer a breaking change — existing non-hybrid
collections automatically gain sparse vectors on next incremental reindex.

BREAKING CHANGE footer required in commit: default changed, but zero user action
needed thanks to the migration.

## Solution

Two separate mechanisms:

### 1. Schema migration v7 — structural: enable sparse config

Add migration v7 to `SchemaManager.ensureCurrentSchema()`. Handles only the
structural change: adding sparse vector configuration to non-hybrid collections.

| Collection state | Config `enableHybrid` | Action                                                                 |
| ---------------- | --------------------- | ---------------------------------------------------------------------- |
| non-hybrid       | `true`                | Add `sparse_vectors: {text: {modifier: "idf"}}` via `updateCollection` |
| non-hybrid       | `false`               | No-op                                                                  |
| hybrid           | any                   | No-op (already has sparse config)                                      |

Schema version bumped to 7 in all cases.

**Ordering contract:** `updateCollectionSparseConfig()` must complete (Qdrant
`updateCollection` is synchronous by default) before `storeSchemaMetadata()` is
called, so the metadata point is stored in the correct format (named vectors if
collection is now hybrid).

**Fallback fix:** `getSchemaVersion()` currently has a fallback that returns
`CURRENT_SCHEMA_VERSION` if a `relativePath` index exists but no metadata point
is found. This must be changed to return hardcoded `6` instead of
`CURRENT_SCHEMA_VERSION`, so v7 migration is not skipped for collections
migrated before metadata points existed.

### 2. Sparse version check — data: rebuild sparse vectors

Separate from schema migration. New `sparseVersion` field in schema metadata
point. Checked at every incremental reindex when `enableHybrid=true`.

Method: `SchemaManager.checkSparseVectorVersion(collectionName)`. Lives on
`SchemaManager` because it owns the metadata point read/write and already
accepts `collectionName`. The `enableHybrid` flag is available via the
constructor parameter added for schema v7.

```
runMigrations(collectionName, absolutePath)
  → ensureCurrentSchema()                    // schema v7: structural changes
  → schemaManager.checkSparseVectorVersion() // data migration
    ├─ enableHybrid=false → skip
    ├─ collection non-hybrid? → updateCollectionSparseConfig()  // safety net
    ├─ sparseVersion in metadata >= CURRENT_SPARSE_VERSION → skip
    └─ sparseVersion missing or < CURRENT_SPARSE_VERSION
       → rebuildSparseVectors(collectionName)
       → save sparseVersion = CURRENT_SPARSE_VERSION in metadata
```

**Why sparse config check is in both places:** Schema v7 adds sparse config on
first migration (optimization — runs once). `checkSparseVectorVersion()` also
checks and adds sparse config as a safety net for the case where a user enables
`enableHybrid=true` after schema v7 already ran as no-op (false→true toggle
after v7).

`CURRENT_SPARSE_VERSION` — a constant bumped whenever the BM25 tokenizer
changes. Currently `1` (the `feb7f14` code tokenizer). Independent of schema
version.

**Schema metadata interface change:**

```typescript
interface SchemaMetadata {
  _type: "schema_metadata";
  schemaVersion: number;
  migratedAt: string;
  indexes: string[];
  sparseVersion?: number; // NEW — absent means 0 (pre-migration)
}
```

This design handles all edge cases:

| Scenario                       | enableHybrid | sparseVersion | Action                          |
| ------------------------------ | ------------ | ------------- | ------------------------------- |
| Tokenizer updated              | `true`       | 0 (old)       | Rebuild                         |
| Fresh hybrid collection        | `true`       | 1 (current)   | Skip                            |
| Non-hybrid → enabled hybrid    | `true`       | missing       | Schema v7 adds config + rebuild |
| Hybrid → disabled → re-enabled | `true`       | 0 (stale)     | Rebuild                         |
| Hybrid → disabled              | `false`      | any           | Skip (no-op)                    |
| Non-hybrid, stays non-hybrid   | `false`      | any           | Skip (no-op)                    |

### `rebuildSparseVectors()` algorithm

```
scroll all points in batches (with vectors + payload)
  for each point:
    if no content in payload → skip (metadata marker, etc.)
    content = point.payload.content
    newSparse = generateSparseVector(content)
    denseVector = extractDenseVector(point)  // handles named & unnamed
  upsert batch with { dense: denseVector, text: newSparse, payload: unchanged }
  log progress every batch
```

Key properties:

- Dense vectors are **read from Qdrant and written back unchanged** — no
  embedding provider needed.
- `scrollWithVectors()` returns point `id`, `payload`, and `vectors`. The dense
  vector may be in named format (`point.vectors.dense` — hybrid collections) or
  unnamed format (`point.vectors` as plain array — pre-hybrid collections after
  Scenario B). `extractDenseVector()` handles both cases, mirroring the pattern
  in `getCollectionInfo()` which checks `"size" in vectorConfig` vs
  `"dense" in vectorConfig`.
- Blocking: runs in `runMigrations()` before reindex starts.
- Progress logged every batch via debug logger.

### Performance

Sparse generation is pure CPU (FNV hash + tokenize). No network calls except
Qdrant scroll/upsert.

| Collection size | Estimated time |
| --------------- | -------------- |
| 2K chunks       | ~2-3 seconds   |
| 10K chunks      | ~5-10 seconds  |
| 50K chunks      | ~20-30 seconds |

One-time per `CURRENT_SPARSE_VERSION` bump.

## Changes

### New

| Component             | What                                       | Purpose                                                                |
| --------------------- | ------------------------------------------ | ---------------------------------------------------------------------- |
| `QdrantManager`       | `updateCollectionSparseConfig(name)`       | Add `sparse_vectors: {text: {modifier: "idf"}}` to existing collection |
| `QdrantManager`       | `scrollWithVectors(name, batchSize)`       | Async generator yielding batches with id + payload + vectors           |
| `SchemaManager`       | `checkSparseVectorVersion(collectionName)` | Read sparseVersion from metadata, rebuild if stale                     |
| `schema-migration.ts` | `CURRENT_SPARSE_VERSION = 1`               | Constant for BM25 tokenizer version                                    |

### Modified

| Component                                 | Change                                                                 |
| ----------------------------------------- | ---------------------------------------------------------------------- |
| `SchemaManager` constructor               | Accept `enableHybrid: boolean` parameter                               |
| `SchemaManager`                           | Add migration v7: add sparse config if non-hybrid + enableHybrid       |
| `schema-migration.ts`                     | `CURRENT_SCHEMA_VERSION = 7`                                           |
| `schema-migration.ts`                     | `getSchemaVersion()` fallback: return `6` not `CURRENT_SCHEMA_VERSION` |
| `schema-migration.ts`                     | `SchemaMetadata` interface: add `sparseVersion?: number`               |
| `IngestDependencies.createSchemaManager`  | Pass `enableHybrid` from config                                        |
| `factory.ts` (`createIngestDependencies`) | Accept + thread `enableHybrid`                                         |
| `IngestFacade`                            | Pass `ingestConfig.enableHybridSearch` to `createIngestDependencies`   |
| `ReindexPipeline.runMigrations()`         | Call `schemaManager.checkSparseVectorVersion()` after schema migration |
| `bootstrap/config/parse.ts`               | Default `enableHybrid` from `false` to `true`                          |

### Not touched

- `generateSparseVector()` — reused as-is
- `ChunkPipeline` — no changes
- `forceReindex` path — creates collection from scratch, no migrations
- Dense vectors — read from scroll, written back unchanged
- Existing migrations v1-v6 — no changes
- `IndexPipeline` — only `ReindexPipeline` runs migrations

## Error handling

- If scroll fails mid-rebuild → abort, `sparseVersion` not updated, retried on
  next reindex
- If upsert fails for a batch → retry once, then abort
- If `updateCollectionSparseConfig` fails → typed error, schema migration aborts
- Points without `content` in payload (metadata marker, `__schema_metadata__`,
  `INDEXING_METADATA_ID`) → skip, no sparse vector generated

## Testing

Unit tests:

1. **Rebuild (Scenario A)**: hybrid collection, sparseVersion=0 → rebuild all
   sparse vectors, dense unchanged, sparseVersion bumped to 1.
2. **Enable hybrid (Scenario B)**: non-hybrid + enableHybrid=true → schema v7
   adds sparse config, then rebuild generates sparse vectors for all points.
3. **Skip — hybrid disabled**: enableHybrid=false → no rebuild, no-op.
4. **Skip — already current**: sparseVersion=1 → no rebuild.
5. **Re-enable hybrid**: was hybrid → disabled → re-enabled, sparseVersion=0 →
   rebuild.
6. **Empty collection**: no points, sparseVersion bumped.
7. **Metadata points skipped**: `__schema_metadata__` and `INDEXING_METADATA_ID`
   not rebuilt.
8. **Unnamed→named vector normalization**: points from pre-hybrid collection
   correctly upserted with named `{dense, text}` format after Scenario B.
9. **getSchemaVersion fallback**: collection with `relativePath` index but no
   metadata point → returns 6, not 7.
10. **Default change**: new config without explicit `enableHybrid` → `true`.
