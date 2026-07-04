# Adaptive Bounds: Remove Static Floor When Collection Stats Available

**Date:** 2026-03-04 **Status:** Approved **Scope:** `core/search/reranker.ts` —
`extractAllDerived` method

## Problem

`defaultBound` acts as a static floor for adaptive bounds, even when
`collectionStats` provides real distribution data. This compresses signals with
large defaultBound (age: 365 days) far more than signals with small defaultBound
(churn: 50), making churn dominate age in presets like techDebt and
securityAudit.

Real data from our index (collection `code_8b243ffe`):

| Signal              | defaultBound | collP95 | Compression ratio |
| ------------------- | ------------ | ------- | ----------------- |
| age (ageDays)       | 365          | 15      | 24x               |
| churn (commitCount) | 50           | 10      | 5x                |
| bugFix              | 100          | 75      | 1.3x              |
| volatility          | 60           | 12      | 5x                |
| density             | 20           | 10      | 2x                |

## Solution

Change `defaultBound` from "always floor" to "fallback when no collectionStats":

```
With collectionStats:    bound = max(batchP95, collectionP95)
Without collectionStats: bound = max(batchP95, defaultBound)  // existing behavior
```

### Change location

`Reranker.extractAllDerived()` in `core/search/reranker.ts`, lines 204-209.

Current:

```typescript
bounds[source] = Math.max(sourceBound, d.defaultBound ?? 1);
```

Proposed:

```typescript
bounds[source] = this.collectionStats
  ? Math.max(sourceBound, 1) // adaptive: collP95 already in sourceBound
  : Math.max(sourceBound, d.defaultBound ?? 1); // fallback: static floor
```

The minimal floor of 1 prevents division by near-zero values.

### Why this works

- `computeAdaptiveBounds` already returns `max(batchP95, collectionP95)` per
  source
- `collectionP95` represents the real distribution of the codebase
- With stats loaded, no static floor is needed — the data speaks for itself
- Without stats (first search before stats computed), defaultBound provides safe
  fallback

### Impact

All presets benefit automatically — the change is in the central bound
resolution. No preset weight changes needed.

### Edge cases

- **Empty batch**: batchP95 returns 1, collP95 provides real floor
- **Very young codebase**: collP95 might be 2-3 days; age=2 →
  normalize(2,3)=0.67 which correctly says "this is relatively old for THIS
  codebase"
- **Mature codebase**: collP95(ageDays) might be 300+, similar to current
  defaultBound
- **No collection stats**: falls back to current behavior (defaultBound as
  floor)
