# rank_chunks — Design

## Problem

`semantic_search` with `decomposition` rerank misses large chunks when the query
doesn't semantically match their content. Example: `query="ingest"` doesn't find
`ReindexPipeline.reindexChanges` (212 lines) because "ingest" is semantically
distant from "reindexing". The decomposition preset boosts by `chunkSize`, but
the chunk must first enter the vector search candidate pool.

We need a tool that ranks all chunks in a collection by rerank signals **without
requiring a semantic query**.

## Solution

New MCP tool **`rank_chunks`** — scroll-based ranking without vector search.

### API

| Parameter     | Type                                 | Required | Description                                               |
| ------------- | ------------------------------------ | -------- | --------------------------------------------------------- |
| `rerank`      | preset name or `{ custom: weights }` | yes      | Rerank strategy (similarity weight ignored)               |
| `level`       | `"chunk" \| "file"`                  | yes      | Analysis level: chunk for active work, file for tech debt |
| `path`        | string                               | no\*     | Path to indexed codebase                                  |
| `collection`  | string                               | no\*     | Collection name directly                                  |
| `pathPattern` | string                               | no       | Glob filter (picomatch)                                   |
| `filter`      | object                               | no       | Qdrant native filter                                      |
| `limit`       | number                               | no       | Top-N results (default 10)                                |
| `metaOnly`    | boolean                              | no       | Metadata only, no content                                 |

\*One of `path` or `collection` required.

### Mechanism: Scatter-Gather via Ordered Scroll

#### Step 1 — Resolve order_by fields

From the preset weights (excluding `similarity`):

1. For each weight key, find the `DerivedSignalDescriptor`
2. Read `descriptor.sources` to get payload field names
3. Select field matching `level` (chunk or file)
4. Read `descriptor.inverted` to determine scroll direction:
   - `inverted=true` → `asc` (e.g., recency: lower ageDays = better)
   - `inverted=false/undefined` → `desc` (e.g., churn: higher commitCount =
     better)

#### Step 2 — Parallel scroll

For each resolved field, call `scrollOrderedBy()` with:

- `order_by: { key: field, direction }`
- `filter` (user-provided Qdrant filter)
- `limit: 3 × requested_limit` (over-fetch factor)

All scrolls execute in parallel.

#### Step 3 — Merge + deduplicate

Union all results by point ID. Deduplicate, keeping one copy per point.

#### Step 4 — Rerank

Pass merged set to existing `Reranker.rerank()`:

- `similarity` weight set to 0, remaining weights re-normalized
- All derived signals extracted from payloads as usual
- Adaptive bounds from collection stats

#### Step 5 — Return top-N

Slice to `limit`, format with ranking overlay.

### Example: decomposition preset

Weights: `{ chunkSize: 0.6, chunkDensity: 0.3, similarity: 0.1 }`

1. Remove similarity → `{ chunkSize: 0.67, chunkDensity: 0.33 }`
2. `ChunkSizeSignal.sources = ["methodLines"]`, `inverted = undefined` → scroll
   `methodLines DESC`
3. `ChunkDensitySignal.sources = ["methodDensity"]`, `inverted = undefined` →
   scroll `methodDensity DESC`
4. Parallel scroll: 30 chunks by methodLines, 30 chunks by methodDensity
5. Merge + deduplicate → ~40-60 unique chunks
6. Rerank → top-10

### Example: techDebt preset (multi-signal, mixed direction)

Weights: `{ age: 0.3, churn: 0.3, stability: 0.2, similarity: 0.2 }`

1. Remove similarity → `{ age: 0.375, churn: 0.375, stability: 0.25 }`
2. `AgeSignal.sources = ["file.ageDays", "chunk.ageDays"]`,
   `inverted = undefined`
   - level=file → scroll `git.file.ageDays DESC`
3. `ChurnSignal.sources = ["file.commitCount", "chunk.commitCount"]`,
   `inverted = undefined`
   - level=file → scroll `git.file.commitCount DESC`
4. `StabilitySignal.sources = ["file.commitCount", "chunk.commitCount"]`,
   `inverted = true`
   - level=file → scroll `git.file.commitCount ASC`
5. Churn and stability use same field, opposite directions — both scrolls run,
   merge captures both extremes
6. Rerank resolves final scores

## Changes Required

### 1. DerivedSignalDescriptor (contracts)

Add one optional field:

```typescript
export interface DerivedSignalDescriptor {
  // ...existing fields
  inverted?: boolean; // true = "1 - normalize()" pattern
}
```

### 2. Derived signal classes (trajectory)

Add `readonly inverted = true` to inverted signals:

- `RecencySignal` (1 - blendNormalized ageDays)
- `StabilitySignal` (1 - blendNormalized commitCount)
- `BlockPenaltySignal` (inverted logic)

All other signals: no change needed (inverted defaults to false).

### 3. adapters/qdrant/scroll.ts

New function:

```typescript
export async function scrollOrderedBy(
  qdrant: QdrantManager,
  collectionName: string,
  orderBy: { key: string; direction: "asc" | "desc" },
  limit: number,
  filter?: Record<string, unknown>,
): Promise<{ id: string | number; payload: Record<string, unknown> }[]>;
```

Uses Qdrant REST `POST /collections/{name}/points/scroll` with `order_by`
parameter.

### 4. core/search/rank-module.ts

New module (same pattern as search-module.ts):

```typescript
export class RankModule {
  constructor(
    private readonly qdrant: QdrantManager,
    private readonly reranker: Reranker,
    private readonly descriptors: DerivedSignalDescriptor[],
  ) {}

  async rankChunks(
    collectionName: string,
    options: RankOptions,
  ): Promise<RerankedResult[]>;
}
```

Orchestrates: resolve fields → parallel scroll → merge → rerank.

### 5. mcp/tools/search.ts

Register `rank_chunks` tool alongside `semantic_search` and `hybrid_search`.

## Layer Compliance

```
mcp/tools/search.ts                → tool definition + deps wiring
  ↓
core/search/rank-module.ts         → orchestration (preset → fields → scatter-gather → rerank)
  ↓                    ↓
core/search/reranker.ts    core/adapters/qdrant/scroll.ts
(existing, no changes)     (new: scrollOrderedBy)
```

| Module                | Imports from                                                        | Layer rule                     |
| --------------------- | ------------------------------------------------------------------- | ------------------------------ |
| `rank-module.ts`      | `contracts/` (DerivedSignalDescriptor), `adapters/qdrant/` (scroll) | domain module → foundation: OK |
| `rank-module.ts`      | `search/reranker.ts`                                                | within same domain: OK         |
| `scroll.ts`           | `adapters/qdrant/client.ts`                                         | within foundation: OK          |
| `mcp/tools/search.ts` | `search/rank-module.ts`, `search/reranker.ts`                       | tool → domain: OK              |

No prohibited dependencies. No cross-domain imports.

## Edge Cases

- **Preset with only `similarity`**: reject — rank_chunks requires at least one
  non-similarity signal
- **Signals without `sources`**: skip (structural signals like `documentation`,
  `pathRisk` use boolean fields, not orderable)
- **Empty scroll results**: return empty array
- **Collection without git enrichment**: git-dependent presets return fewer/no
  results — expected behavior
- **Same payload field, opposite directions** (churn + stability): both scrolls
  run, merge captures both extremes, reranker resolves

## Not In Scope

- No changes to Reranker internals
- No changes to existing preset weights
- No new presets
- No SearchFacade wrapper (follows semantic_search pattern, direct tool →
  module)
