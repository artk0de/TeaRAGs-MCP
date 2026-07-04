# get_index_metrics — Design Document

## Goal

New MCP tool that returns collection statistics with percentile-based thresholds
so LLM agents can dynamically choose appropriate filter values instead of
guessing. Also: add threshold labels to rankingOverlay and remove derived
signals from overlay.

## Architecture

`get_index_metrics` exposes data already computed by `computeCollectionStats()`,
extended with distributions (languages, chunkTypes, authors) and min/max. Signal
descriptors declare threshold labels (`stats.labels`), thresholds are
auto-computed from cached percentile values relative to the specific codebase.

## API

### App Interface

```typescript
getIndexMetrics(path: string): Promise<IndexMetrics>
```

### IndexMetrics Type

```typescript
interface IndexMetrics {
  collection: string;
  totalChunks: number;
  totalFiles: number;

  distributions: {
    language: Record<string, number>;
    chunkType: Record<string, number>;
    documentation: { docs: number; code: number };
    topAuthors: { name: string; chunks: number }[]; // top-10
    othersCount: number;
  };

  signals: Record<
    string,
    {
      stats: {
        min: number;
        max: number;
        mean: number;
        stddev: number;
        count: number;
        percentiles: Record<number, number>; // { 25: 1, 50: 3, 75: 7, 95: 18 }
      };
      thresholds: Record<string, number>; // { "low": 1, "typical": 3, "high": 7, "extreme": 18 }
    }
  >;
}
```

### MCP Tool

- Name: `get_index_metrics`
- Input: `{ path: string }`
- Output: `IndexMetrics` JSON
- Annotations: `{ readOnlyHint: true }`
- Description: "Get collection statistics and signal distributions. Returns
  percentile-based thresholds for git signals, language/author/chunkType
  distributions. Use to discover appropriate filter values for your codebase."

## Signal Threshold Labels

Each payload signal descriptor declares `stats.labels` mapping percentile to
semantic name. Threshold values are computed from real codebase data.

### Git File Signals

| Signal                         | Percentiles      | Labels                            |
| ------------------------------ | ---------------- | --------------------------------- |
| `git.file.commitCount`         | [25, 50, 75, 95] | low, typical, high, extreme       |
| `git.file.ageDays`             | [25, 50, 75, 95] | recent, typical, old, legacy      |
| `git.file.bugFixRate`          | [50, 75, 95]     | healthy, concerning, critical     |
| `git.file.dominantAuthorPct`   | [25, 50, 75, 95] | shared, mixed, concentrated, silo |
| `git.file.contributorCount`    | [50, 75, 95]     | solo, team, crowd                 |
| `git.file.relativeChurn`       | [75, 95]         | normal, high                      |
| `git.file.changeDensity`       | [50, 75, 95]     | calm, active, intense             |
| `git.file.churnVolatility`     | [75, 95]         | stable, erratic                   |
| `git.file.recencyWeightedFreq` | [75, 95]         | normal, burst                     |

### Git Chunk Signals

| Signal                          | Percentiles      | Labels                        |
| ------------------------------- | ---------------- | ----------------------------- |
| `git.chunk.commitCount`         | [25, 50, 75, 95] | low, typical, high, extreme   |
| `git.chunk.ageDays`             | [25, 50, 75, 95] | recent, typical, old, legacy  |
| `git.chunk.bugFixRate`          | [50, 75, 95]     | healthy, concerning, critical |
| `git.chunk.churnRatio`          | [75, 95]         | normal, concentrated          |
| `git.chunk.contributorCount`    | [50, 95]         | solo, crowd                   |
| `git.chunk.relativeChurn`       | [75, 95]         | normal, high                  |
| `git.chunk.changeDensity`       | [75, 95]         | active, intense               |
| `git.chunk.churnVolatility`     | [75, 95]         | stable, erratic               |
| `git.chunk.recencyWeightedFreq` | [75, 95]         | normal, burst                 |

### Static Signals

| Signal          | Percentiles  | Labels                                |
| --------------- | ------------ | ------------------------------------- |
| `methodLines`   | [50, 75, 95] | small, large, decomposition_candidate |
| `methodDensity` | [50, 95]     | sparse, dense                         |

## Descriptor Extension

```typescript
// contracts/types/provider.ts
interface PayloadSignalDescriptor {
  key: string;
  stats?: {
    percentiles: number[];
    labels?: Record<number, string>; // NEW: { 25: "low", 50: "typical", ... }
  };
}
```

## Threshold Computation

```typescript
for (const signal of signalDescriptors) {
  if (!signal.stats?.labels) continue;
  const cached = statsCache.get(collection, signal.key);
  const thresholds: Record<string, number> = {};
  for (const [percentile, label] of Object.entries(signal.stats.labels)) {
    thresholds[label] = cached.percentiles[Number(percentile)];
  }
  result.signals[signal.key] = { stats: cached, thresholds };
}
```

## Distributions

Computed during `computeCollectionStats()` scroll, stored in
`CollectionSignalStats.distributions`:

- `language` — count per language from payload
- `chunkType` — count per chunkType
- `documentation` — count of `isDocumentation: true` vs false
- `topAuthors` — top-10 by `git.file.dominantAuthor` + `othersCount`

## Caching Strategy

- **Eager**: `index_codebase` and `reindex_changes` compute stats after indexing
- **Lazy fallback**: `get_index_metrics` calls `ensureStats()` if cache is empty
- Cache stored as JSON in snapshots directory (existing StatsCache mechanism)

## Stats Fields

All numeric signals with `stats` always get: **min, max, mean, stddev, count**
plus requested percentiles. min/max are zero-cost (single accumulator in
existing scroll loop).

## RankingOverlay Changes (BREAKING)

### Remove derived from overlay

Before:

```json
{
  "preset": "techDebt",
  "derived": { "recency": 0.31, "churn": 0.82 },
  "raw": { "file": { "commitCount": 12 } }
}
```

After:

```json
{
  "preset": "techDebt",
  "raw": {
    "file": { "commitCount": 12, "ageDays": 145 },
    "chunk": { "commitCount": 8, "ageDays": 90 }
  },
  "labels": {
    "file": { "commitCount": "high", "ageDays": "old" },
    "chunk": { "commitCount": "high", "ageDays": "typical" }
  }
}
```

### Label resolution

When `rerank` parameter is provided, Reranker builds overlay as before. After
building raw overlay, looks up threshold labels from StatsCache: if
`value >= p75 && value < p95` -> label for p75 percentile.

### RankingOverlay type change

```typescript
interface RankingOverlay {
  preset: string;
  file?: Record<string, unknown>;
  chunk?: Record<string, unknown>;
  // REMOVED: derived?: Record<string, number>;
  labels?: {
    // NEW
    file?: Record<string, string>;
    chunk?: Record<string, string>;
  };
}
```

## Documentation

Schema documentation MCP Resource (tea-rags://schema/documentation) must
describe what threshold labels mean: semantic status of a signal value relative
to the current codebase distribution (e.g., "high" = above p75 of all chunks in
this collection).

## Files Affected

- `src/core/contracts/types/provider.ts` — extend PayloadSignalDescriptor
- `src/core/contracts/types/reranker.ts` — RankingOverlay: remove derived, add
  labels
- `src/core/trajectory/git/signals.ts` — add labels to git signal descriptors
- `src/core/trajectory/static/payload-signals.ts` — add labels to static signals
- `src/core/ingest/collection-stats.ts` — compute distributions + min/max
- `src/core/infra/stats-cache.ts` — extend CollectionSignalStats with
  distributions
- `src/core/explore/reranker.ts` — remove derived from overlay, add labels
- `src/core/api/app.ts` — add getIndexMetrics to App interface
- `src/core/api/create-app.ts` — implement getIndexMetrics
- `src/mcp/tools/code.ts` — register get_index_metrics tool
- `src/mcp/tools/schemas.ts` — GetIndexMetricsSchema
- Tests for all above
