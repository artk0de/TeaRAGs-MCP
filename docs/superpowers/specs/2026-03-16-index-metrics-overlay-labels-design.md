# get_index_metrics + Overlay Labels — Design Spec

## Goal

1. New MCP tool `get_index_metrics` returning collection statistics with
   percentile-based thresholds so LLM agents can choose filter values
   dynamically.
2. Add human-readable labels to ranking overlay so agents interpret search
   results without cross-referencing stats.
3. Remove `derived` from `RankingOverlay` — normalized 0-1 values are
   meaningless to consumers.

## Use Cases

1. **Agent selects filter values** — calls `get_index_metrics` once per session,
   reads `labelMap` to understand what "high churn" means for this codebase.
2. **Agent interprets overlay** — each raw value in overlay carries a label
   (`{ value: 12, label: "high" }`), no need to compare with stats table.
3. **Human inspects collection** — distributions show language/author/chunkType
   breakdown, spot anomalies.
4. **Agent builds reports** — groups results by labels (e.g. "5 files extreme
   churn + legacy") without extra tool calls.
5. **Index diagnostics** — low chunk count, language skew, missing git data
   visible from one call.

## Design Decisions

- **Labels in overlay are automatic** — reranker attaches labels to all raw
  values whose descriptor has `stats.labels`. Presets do not control labels.
- **Label resolution rule** — value falls into the bucket of the highest
  threshold it exceeds. Below the first threshold → first label. Above the last
  → last label. A label is always present when `stats.labels` exists.
- **`derived` removed from overlay** — derived signals remain for scoring
  internally but are not projected to output.
- **`percentiles` field removed from `SignalStatsRequest`** — `labels` is the
  sole mechanism to declare which percentiles to collect.
- **No shared label constants** — labels are inline in each descriptor.
- **One call per session** — `get_index_metrics` returns stable data between
  reindexes.

---

## Section 1: PayloadSignalDescriptor Extension

### Changes to `SignalStatsRequest`

**File:** `src/core/contracts/types/trajectory.ts:9-16`

Before:

```typescript
export interface SignalStatsRequest {
  percentiles?: number[];
  mean?: boolean;
  stddev?: boolean;
}
```

After:

```typescript
export interface SignalStatsRequest {
  labels?: Record<string, string>; // { p25: "low", p50: "typical", p75: "high", p95: "extreme" }
  mean?: boolean;
  stddev?: boolean;
}
```

`percentiles` is removed. Percentiles to collect are derived from `labels` keys:
`Object.keys(labels).map(k => Number(k.slice(1)))`.

### Signal Descriptor Examples

**Git signals** (`src/core/domains/trajectory/git/payload-signals.ts`):

```typescript
{
  key: "git.file.commitCount",
  type: "number",
  description: "Total commits touching the file",
  stats: { labels: { p25: "low", p50: "typical", p75: "high", p95: "extreme" } }
}

{
  key: "git.file.ageDays",
  type: "number",
  description: "Days since file was first committed",
  stats: { labels: { p25: "recent", p50: "typical", p75: "old", p95: "legacy" } }
}

{
  key: "git.file.bugFixRate",
  type: "number",
  description: "Percentage of commits that are bug fixes",
  stats: { labels: { p50: "healthy", p75: "concerning", p95: "critical" } }
}
```

**Static signals** (`src/core/domains/trajectory/static/payload-signals.ts`):

```typescript
{
  key: "methodLines",
  type: "number",
  description: "Lines of code in the chunk",
  stats: { labels: { p50: "small", p75: "large", p95: "decomposition_candidate" } }
}
```

### Full Label Map per Signal

Defined in the design doc `docs/plans/2026-03-13-get-index-metrics-design.md`,
section "Signal Threshold Labels". All signals retain their declared label sets.

| Signal                          | Labels                                            |
| ------------------------------- | ------------------------------------------------- |
| `git.file.commitCount`          | p25:low, p50:typical, p75:high, p95:extreme       |
| `git.file.ageDays`              | p25:recent, p50:typical, p75:old, p95:legacy      |
| `git.file.bugFixRate`           | p50:healthy, p75:concerning, p95:critical         |
| `git.file.dominantAuthorPct`    | p25:shared, p50:mixed, p75:concentrated, p95:silo |
| `git.file.contributorCount`     | p50:solo, p75:team, p95:crowd                     |
| `git.file.relativeChurn`        | p75:normal, p95:high                              |
| `git.file.changeDensity`        | p50:calm, p75:active, p95:intense                 |
| `git.file.churnVolatility`      | p75:stable, p95:erratic                           |
| `git.file.recencyWeightedFreq`  | p75:normal, p95:burst                             |
| `git.chunk.commitCount`         | p25:low, p50:typical, p75:high, p95:extreme       |
| `git.chunk.ageDays`             | p25:recent, p50:typical, p75:old, p95:legacy      |
| `git.chunk.bugFixRate`          | p50:healthy, p75:concerning, p95:critical         |
| `git.chunk.churnRatio`          | p75:normal, p95:concentrated                      |
| `git.chunk.contributorCount`    | p50:solo, p95:crowd                               |
| `git.chunk.relativeChurn`       | p75:normal, p95:high                              |
| `git.chunk.changeDensity`       | p75:active, p95:intense                           |
| `git.chunk.churnVolatility`     | p75:stable, p95:erratic                           |
| `git.chunk.recencyWeightedFreq` | p75:normal, p95:burst                             |
| `methodLines`                   | p50:small, p75:large, p95:decomposition_candidate |
| `methodDensity`                 | p50:sparse, p95:dense                             |

---

## Section 2: RankingOverlay — New Format

**File:** `src/core/contracts/types/reranker.ts:73-78`

Before:

```typescript
export interface RankingOverlay {
  preset: string;
  file?: Record<string, unknown>;
  chunk?: Record<string, unknown>;
  derived?: Record<string, number>;
}
```

After:

```typescript
export interface RankingOverlay {
  preset: string;
  file?: Record<string, unknown>;
  chunk?: Record<string, unknown>;
}
```

`derived` field is removed entirely.

### Output Format

Numeric signals with `stats.labels` produce `{ value, label }`. Others remain
plain values.

```json
{
  "preset": "techDebt",
  "file": {
    "commitCount": { "value": 12, "label": "high" },
    "ageDays": { "value": 145, "label": "old" },
    "dominantAuthor": "Arthur"
  },
  "chunk": {
    "commitCount": { "value": 8, "label": "high" }
  }
}
```

---

## Section 3: Label Resolution in Reranker

### Component

Internal component of `Reranker` — isolated class or private method. Not
exported beyond reranker boundary.

**Input:** raw numeric value, cached percentile values, descriptor
`stats.labels`.

**Algorithm:**

Walk thresholds in ascending order. Each label covers the range from its
threshold (inclusive) up to the next threshold (exclusive). The first label also
covers everything below its threshold. The last label covers everything at or
above its threshold.

```
labels: { p25: "low", p50: "typical", p75: "high", p95: "extreme" }
percentile values from cache: { 25: 2, 50: 5, 75: 12, 95: 30 }

Buckets:
  "low"      = [0, 5)      — below p50 threshold
  "typical"  = [5, 12)     — from p50 to p75
  "high"     = [12, 30)    — from p75 to p95
  "extreme"  = [30, ∞)     — at or above p95

commitCount = 1  →  in [0, 5)      → "low"
commitCount = 3  →  in [0, 5)      → "low"
commitCount = 5  →  in [5, 12)     → "typical"
commitCount = 8  →  in [5, 12)     → "typical"
commitCount = 12 →  in [12, 30)    → "high"
commitCount = 15 →  in [12, 30)    → "high"
commitCount = 30 →  in [30, ∞)     → "extreme"
commitCount = 35 →  in [30, ∞)     → "extreme"
```

A label is always present when `stats.labels` exists in the descriptor.

### Integration Point

`buildOverlay()` in `src/core/domains/explore/reranker.ts:339`:

1. Collects raw file/chunk values (existing logic)
2. For each numeric value: finds descriptor with `stats.labels`
3. If found: resolves label from StatsCache percentiles
4. Replaces plain value with `{ value, label }`

### OverlayMask Change

**File:** `src/core/contracts/types/reranker.ts:48-52`

Before:

```typescript
export interface OverlayMask {
  readonly file?: string[];
  readonly chunk?: string[];
  readonly derived?: string[];
}
```

After:

```typescript
export interface OverlayMask {
  readonly file?: string[];
  readonly chunk?: string[];
}
```

### Presets Affected

Remove `derived` from `overlayMask` in:

- `RefactoringPreset` (`trajectory/git/rerank/presets/refactoring.ts:21`) — had
  `derived: ["chunkSize", "chunkDensity", "chunkChurn", "volatility"]`
- `DecompositionPreset` (`trajectory/static/rerank/presets/decomposition.ts:14`)
  — had `derived: ["chunkSize", "chunkDensity"]` — after removing `derived`,
  mask becomes empty `{}`. Add `file: ["methodLines"]` to surface chunk size
  info via raw values + labels (replaces the information previously conveyed by
  derived chunkSize/chunkDensity). `methodLines` is a flat payload key, not
  chunk-namespaced, so only `file` mask applies.

---

## Section 4: `computeCollectionStats` Extension

**File:** `src/core/domains/ingest/collection-stats.ts:49`

### SignalStats — Add min/max

**File:** `src/core/contracts/types/trajectory.ts:33-39`

Before:

```typescript
export interface SignalStats {
  count: number;
  percentiles?: Record<number, number>;
  mean?: number;
  stddev?: number;
}
```

After:

```typescript
export interface SignalStats {
  count: number;
  min: number;
  max: number;
  percentiles: Record<number, number>;
  mean?: number;
  stddev?: number;
}
```

`min`, `max`, `percentiles` become required (always computed when stats exist).

### CollectionSignalStats — Add Distributions

**File:** `src/core/contracts/types/trajectory.ts:42-45`

After:

```typescript
export interface Distributions {
  totalFiles: number;
  language: Record<string, number>;
  chunkType: Record<string, number>;
  documentation: { docs: number; code: number };
  topAuthors: { name: string; chunks: number }[];
  othersCount: number;
}

export interface CollectionSignalStats {
  perSignal: Map<string, SignalStats>;
  distributions: Distributions;
  computedAt: number;
}
```

### Computation Changes

`computeCollectionStats()` now:

1. Derives percentiles from `stats.labels` keys instead of `stats.percentiles`
2. Tracks min/max per signal (two accumulators, zero cost)
3. Aggregates distributions during the same scroll pass:
   - `language` from payload `language` field
   - `chunkType` from payload `chunkType` field
   - `documentation` from payload `isDocumentation` boolean
   - authors from payload `git.file.dominantAuthor`, top-10 + othersCount

### StatsCache Version Bump

**File:** `src/core/infra/stats-cache.ts`

Cache file version bumps from 2 to 3. Old caches auto-rejected on load,
triggering lazy recomputation.

New `StatsFileContent`:

```typescript
interface StatsFileContent {
  version: 3;
  collectionName: string;
  computedAt: number;
  perSignal: Record<string, SignalStats>;
  distributions: Distributions;
  payloadFieldKeys?: string[];
}
```

---

## Section 5: `get_index_metrics` MCP Tool

### App Interface

**File:** `src/core/api/public/app.ts`

Add to `App` interface:

```typescript
getIndexMetrics(path: string): Promise<IndexMetrics>
```

### IndexMetrics DTO

**File:** `src/core/api/public/dto/` (new file)

```typescript
export interface IndexMetrics {
  collection: string;
  totalChunks: number;
  totalFiles: number;

  distributions: {
    language: Record<string, number>;
    chunkType: Record<string, number>;
    documentation: { docs: number; code: number };
    topAuthors: { name: string; chunks: number }[];
    othersCount: number;
  };

  signals: Record<
    string,
    {
      min: number;
      max: number;
      mean?: number;
      count: number;
      labelMap: Record<string, number>;
    }
  >;
}
```

`labelMap` maps label name → threshold value. Built from descriptor
`stats.labels` + cached percentile values.

Example:

```json
{
  "collection": "code_8b243ffe",
  "totalChunks": 1709,
  "totalFiles": 314,
  "distributions": {
    "language": { "typescript": 1200, "markdown": 300, "json": 100 },
    "chunkType": { "function": 800, "class": 200, "block": 500 },
    "documentation": { "docs": 150, "code": 1559 },
    "topAuthors": [
      { "name": "Arthur", "chunks": 1400 },
      { "name": "Bot", "chunks": 200 }
    ],
    "othersCount": 109
  },
  "signals": {
    "git.file.commitCount": {
      "min": 1,
      "max": 47,
      "mean": 5.2,
      "count": 1709,
      "labelMap": { "low": 2, "typical": 5, "high": 12, "extreme": 30 }
    },
    "git.file.ageDays": {
      "min": 1,
      "max": 400,
      "mean": 85.3,
      "count": 1709,
      "labelMap": { "recent": 5, "typical": 30, "old": 90, "legacy": 200 }
    }
  }
}
```

### MCP Tool Registration

**File:** `src/mcp/tools/` (register in tool list)

- Name: `get_index_metrics`
- Input: `{ path: string }`
- Output: `IndexMetrics` JSON
- Annotations: `{ readOnlyHint: true }`
- Description: "Get collection statistics and signal distributions. Returns
  percentile-based thresholds for git signals, language/author/chunkType
  distributions. Use to discover appropriate filter values for your codebase."

### Implementation

`getIndexMetrics()` in facade:

1. Resolve collection name from path
2. `ensureStats()` — load from cache or compute on the fly
3. Build `IndexMetrics` DTO from `CollectionSignalStats`:
   - `totalChunks` from collection info, `totalFiles` from
     `distributions.totalFiles` (computed as distinct `relativePath` count
     during scroll pass)
   - `distributions` directly from stats
   - For each signal with `stats.labels`: build `labelMap` by mapping label
     names to cached percentile values

---

## Section 6: Eager Stats + Lazy Fallback

No new components. Existing flow covers this:

- `IngestFacade.refreshStats()` already runs after `indexCodebase()` and
  `reindexChanges()` — now collects extended stats (distributions, min/max)
- `ExploreFacade.ensureStats()` already loads cache before first search — used
  by `getIndexMetrics` as lazy fallback
- StatsCache v3 — old v2 cache auto-rejected, recomputed on first access

---

## Files Affected

| File                                                | Change                                                                                                                                                                                               |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contracts/types/trajectory.ts`                     | `SignalStatsRequest`: replace `percentiles` with `labels`; `SignalStats`: add `min`, `max`, make `percentiles` required; `CollectionSignalStats`: add `distributions`; add `Distributions` interface |
| `contracts/types/reranker.ts`                       | `RankingOverlay`: remove `derived`; `OverlayMask`: remove `derived`                                                                                                                                  |
| `trajectory/git/payload-signals.ts`                 | Replace `stats: { percentiles }` with `stats: { labels }` for all numeric signals                                                                                                                    |
| `trajectory/static/payload-signals.ts`              | Replace `stats: { percentiles }` with `stats: { labels }` for `methodLines`, `methodDensity`                                                                                                         |
| `trajectory/git/rerank/presets/refactoring.ts`      | Remove `derived` from `overlayMask`                                                                                                                                                                  |
| `trajectory/static/rerank/presets/decomposition.ts` | Remove `derived` from `overlayMask`                                                                                                                                                                  |
| `domains/ingest/collection-stats.ts`                | Derive percentiles from labels keys; compute min/max; aggregate distributions                                                                                                                        |
| `domains/explore/reranker.ts`                       | Remove derived overlay block; add label resolution in `buildOverlay()`                                                                                                                               |
| `infra/stats-cache.ts`                              | Version bump to 3; serialize/deserialize `distributions`                                                                                                                                             |
| `api/public/app.ts`                                 | Add `getIndexMetrics()` to `App` interface                                                                                                                                                           |
| `api/public/dto/`                                   | New `IndexMetrics` DTO                                                                                                                                                                               |
| `api/internal/facades/explore-facade.ts`            | Implement `getIndexMetrics()`                                                                                                                                                                        |
| `mcp/tools/`                                        | Register `get_index_metrics` tool                                                                                                                                                                    |

## Not Changed

- Derived signal classes — remain for scoring
- Adaptive bounds logic — reads percentiles from SignalStats (field still
  exists)
- Reranker scoring pipeline — weights, alpha-blending, dampening unchanged
- DampeningConfig — continues to read from `SignalStats.percentiles` which is
  now populated from `labels` keys. Dampening percentile values (e.g. `25`) must
  correspond to a percentile declared in some signal's `stats.labels`.
- `reindex_changes` / `index_codebase` tool interfaces unchanged
- Existing search tool schemas — no new parameters

## Implementation Notes

- `computeCollectionStats` existing filter `val > 0` is preserved — min/max only
  cover positive values. This matches existing behavior for percentiles.
- `methodDensity` gains p50 (was only p95). `methodLines` gains p75 (was p50,
  p95). Intentional expansion to support label resolution.
- `getIndexMetrics()` lives in ExploreFacade which already has access to
  StatsCache via `ensureStats()`. Needs additional access to
  `PayloadSignalDescriptor[]` (from TrajectoryRegistry) to build `labelMap`.
  TrajectoryRegistry is already a dependency of ExploreFacade.
