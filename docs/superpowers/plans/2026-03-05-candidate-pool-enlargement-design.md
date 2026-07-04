# Candidate Pool Enlargement Design

**Issue:** tea-rags-mcp-47m **Date:** 2026-03-05 **Status:** Approved

## Problem

Current pool sizing is inconsistent and too small for quality reranking:

- `calculateFetchLimit` in `filters/glob.ts`: ×1 base, ×3 with
  pathPattern/rerank
- `hybridSearch` in `client.ts`: hardcoded `Math.max(20, limit * 4)` with
  internal slice
- Two separate formulas, two separate concerns — fragile, hard to reason about

Industry best practice for RAG/vector search: ×4–×6 overfetch before reranking,
50–100 candidates for typical applications.

## Solution

Unify into a single `calculateFetchLimit` function with raised defaults:

```
base:      Math.max(20, limit × 4)
overfetch: Math.max(20, limit × 6)
```

Overfetch triggers when `pathPattern` or `rerank !== "relevance"`.

No new MCP parameters — candidate pool is an implementation detail, agents see
only `limit`.

## Changes

| File                                      | Change                                                                                                                               |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `adapters/qdrant/filters/glob.ts`         | Update `calculateFetchLimit`: base ×4 (min 20), overfetch ×6 (min 20)                                                                |
| `adapters/qdrant/client.ts`               | `hybridSearch()`: remove internal fetchLimit calculation, remove `slice(0, limit)`. Rename `limit` param to `fetchLimit` for clarity |
| `mcp/tools/search.ts`                     | Ensure hybrid_search caller slices to `requestedLimit` after results (already does via `applyPostProcessing`)                        |
| `search/search-module.ts`                 | No changes — already uses `calculateFetchLimit`                                                                                      |
| `mcp/tools/formatters/search-pipeline.ts` | No changes — already wraps `calculateFetchLimit`                                                                                     |

## Contract Change: hybridSearch

**Before:**
`hybridSearch(collection, dense, sparse, limit, filter, semanticWeight)` —
computes fetchLimit internally, slices to limit **After:**
`hybridSearch(collection, dense, sparse, fetchLimit, filter, semanticWeight)` —
receives fetchLimit, returns all fused results

Both callers (`SearchModule.searchCode`, `mcp/tools/search.ts`) already pass
computed fetchLimit and slice results downstream.

## Expected Impact

| Scenario         | limit | Before                 | After           |
| ---------------- | ----- | ---------------------- | --------------- |
| Simple search    | 10    | 10 candidates          | 40 candidates   |
| With rerank      | 10    | 30                     | 60              |
| With pathPattern | 10    | 30                     | 60              |
| Hybrid simple    | 10    | 40 (internal ×4)       | 40 (unified ×4) |
| Hybrid + rerank  | 10    | 40 (overfetch ignored) | 60              |

## What Does NOT Change

- MCP tool schemas — no new parameters
- Agent-facing behavior — limit controls output size as before
- Search result format — unchanged
