# metaOnly git masking design

## Problem

When `metaOnly=true`, the full `git` object is returned with all raw signals (ageDays, commitCount, churnVolatility, bugFixRate, changeDensity, recencyWeightedFreq, etc.). This is noise for agents — most signals are irrelevant for the current query's preset.

Additionally, `rankingOverlay` duplicates raw values already present in `git`.

## Solution

Mask the `git` object in metaOnly results using two mechanisms:

1. **Overlay mask** — when reranking is active and the preset defines an overlay mask, use it to filter git fields
2. **Essential signals** — when no overlay mask applies, show only signals marked `essential: true` in their descriptor

Remove `rankingOverlay` from metaOnly output (its data is absorbed into the masked `git`). Add `preset` as a top-level field.

## Design

### 1. Add `essential` flag to `PayloadSignalDescriptor`

**File:** `src/core/contracts/types/trajectory.ts`

```typescript
export interface PayloadSignalDescriptor {
  key: string;
  type: "string" | "number" | "boolean" | "string[]" | "timestamp";
  description: string;
  stats?: SignalStatsRequest;
  /** Include in metaOnly results even without overlay mask. Default: false. */
  essential?: boolean;
}
```

### 2. Mark essential git signals

**File:** `src/core/trajectory/git/payload-signals.ts`

```typescript
{ key: "git.file.ageDays", ..., essential: true },
{ key: "git.file.commitCount", ..., essential: true },
{ key: "git.chunk.ageDays", ..., essential: true },
{ key: "git.chunk.commitCount", ..., essential: true },
```

### 3. Aggregate essential fields at startup

**File:** `src/core/trajectory/index.ts` (TrajectoryRegistry)

Add helper to collect essential payload signal keys from all trajectories:

```typescript
getEssentialPayloadKeys(): string[] {
  return this.getAll()
    .flatMap(t => t.payloadSignals)
    .filter(s => s.essential)
    .map(s => s.key);
}
```

### 4. Pass through deps

**File:** `src/mcp/tools/search.ts`

```typescript
export interface SearchToolDependencies {
  // ...existing...
  essentialTrajectoryFields: string[];
}
```

Composition root calls `registry.getEssentialPayloadKeys()` and passes result.

### 5. Mask git in formatter

**File:** `src/mcp/tools/formatters/search-pipeline.ts`

```typescript
formatSearchResults(results, metaOnly, essentialTrajectoryFields?)
```

When `metaOnly=true`:

| Condition | `git` content | `preset` | `rankingOverlay` |
|-----------|--------------|----------|------------------|
| rankingOverlay has file/chunk data | overlay file/chunk values | top-level | removed |
| rankingOverlay exists but empty | essential fields only | top-level | removed |
| no rankingOverlay | essential fields only | absent | absent |

Git masking logic:
- **Overlay case:** `git.file` = `rankingOverlay.file`, `git.chunk` = `rankingOverlay.chunk`
- **Essential case:** filter `git.file` and `git.chunk` by keys from `essentialTrajectoryFields`

### 6. metaOnly=false unchanged

Full results always include complete `git` and `rankingOverlay` as before.

## Example output

### Before (metaOnly + hotspots)

```json
{
  "score": 0.42,
  "relativePath": "src/core/search/reranker.ts",
  "parentName": "Reranker",
  "git": {
    "chunk": {
      "commitCount": 8, "churnRatio": 0.36, "contributorCount": 1,
      "bugFixRate": 17, "ageDays": 1, "relativeChurn": 8.13,
      "recencyWeightedFreq": 5.42, "changeDensity": 8, "churnVolatility": 0.93
    }
  },
  "rankingOverlay": {
    "preset": "hotspots",
    "chunk": { "commitCount": 8, "churnRatio": 0.36 }
  }
}
```

### After (metaOnly + hotspots)

```json
{
  "score": 0.42,
  "relativePath": "src/core/search/reranker.ts",
  "parentName": "Reranker",
  "preset": "hotspots",
  "git": {
    "chunk": { "commitCount": 8, "churnRatio": 0.36 }
  }
}
```

### After (metaOnly + relevance / no rerank)

```json
{
  "score": 0.42,
  "relativePath": "src/core/search/reranker.ts",
  "parentName": "Reranker",
  "git": {
    "chunk": { "ageDays": 1, "commitCount": 8 }
  }
}
```

## Files to modify

1. `src/core/contracts/types/trajectory.ts` — add `essential?: boolean`
2. `src/core/trajectory/git/payload-signals.ts` — mark 4 signals essential
3. `src/core/trajectory/index.ts` — `getEssentialPayloadKeys()` helper
4. `src/mcp/tools/search.ts` — add `essentialTrajectoryFields` to deps
5. `src/mcp/tools/formatters/search-pipeline.ts` — masking logic in `formatSearchResults`
6. Composition root — wire essential fields from registry to search deps

## Verification

1. `npx tsc --noEmit`
2. `npx vitest run`
3. Real semantic_search with `metaOnly=true, rerank="hotspots"` — verify git is masked
4. Real semantic_search with `metaOnly=true` (no rerank) — verify git has only essential fields
5. Real semantic_search with `metaOnly=false` — verify full git + rankingOverlay unchanged
