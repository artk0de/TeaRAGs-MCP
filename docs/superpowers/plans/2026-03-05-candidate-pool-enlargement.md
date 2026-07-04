# Candidate Pool Enlargement Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to
> implement this plan task-by-task.

**Goal:** Unify and raise candidate pool defaults so all search paths use one
formula (×4 base, ×6 overfetch) and hybridSearch has the same contract as
search().

**Architecture:** Single `calculateFetchLimit` function becomes the only source
of truth for pool sizing. `hybridSearch` loses its internal fetchLimit
calculation and slice — callers control both. No MCP schema changes.

**Tech Stack:** TypeScript, Vitest

**Design doc:** `docs/plans/2026-03-05-candidate-pool-enlargement-design.md`

---

### Task 1: Update calculateFetchLimit formula and tests

**Files:**

- Modify: `src/core/adapters/qdrant/filters/glob.ts:57-70`
- Modify: `tests/qdrant/filters/glob.test.ts:154-174`
- Modify: `tests/mcp/tools/search.test.ts:74-87`

**Step 1: Update tests for new formula**

In `tests/qdrant/filters/glob.test.ts`, replace the `calculateFetchLimit`
describe block (lines 154-174):

```typescript
describe("calculateFetchLimit", () => {
  it("should apply base multiplier (×4, min 20) when no overfetch needed", () => {
    expect(calculateFetchLimit(10, false)).toBe(40); // 10 * 4
    expect(calculateFetchLimit(5, false)).toBe(20); // max(20, 5 * 4)
    expect(calculateFetchLimit(3, false)).toBe(20); // max(20, 3 * 4) = max(20, 12) = 20
  });

  it("should apply overfetch multiplier (×6, min 20) when pattern/rerank active", () => {
    expect(calculateFetchLimit(10, true)).toBe(60); // 10 * 6
    expect(calculateFetchLimit(5, true)).toBe(30); // 5 * 6
    expect(calculateFetchLimit(3, true)).toBe(20); // max(20, 3 * 6) = max(20, 18) = 20
  });

  it("should enforce minimum of 20 candidates", () => {
    expect(calculateFetchLimit(1, false)).toBe(20); // max(20, 1 * 4)
    expect(calculateFetchLimit(1, true)).toBe(20); // max(20, 1 * 6)
    expect(calculateFetchLimit(0, false)).toBe(20); // max(20, 0)
    expect(calculateFetchLimit(0, true)).toBe(20); // max(20, 0)
  });
});
```

In `tests/mcp/tools/search.test.ts`, replace the `calculateFetchLimit` describe
block (lines 74-87):

```typescript
describe("calculateFetchLimit", () => {
  it("should apply base multiplier when no overfetch needed", () => {
    expect(calculateFetchLimit(5, false)).toBe(20); // max(20, 5 * 4)
    expect(calculateFetchLimit(10, false)).toBe(40); // 10 * 4
  });

  it("should apply overfetch multiplier when pattern/rerank active", () => {
    expect(calculateFetchLimit(5, true)).toBe(30); // 5 * 6
    expect(calculateFetchLimit(10, true)).toBe(60); // 10 * 6
  });
});
```

**Step 2: Run tests to verify they fail**

Run:
`npx vitest run tests/qdrant/filters/glob.test.ts tests/mcp/tools/search.test.ts`
Expected: FAIL — old formula produces wrong values (e.g.,
`calculateFetchLimit(10, false)` returns 10, not 40)

**Step 3: Update calculateFetchLimit implementation**

In `src/core/adapters/qdrant/filters/glob.ts`, replace lines 57-70:

```typescript
/**
 * Calculates fetch limit for Qdrant queries.
 *
 * Always overfetches to ensure enough candidates for post-processing
 * (glob filtering, reranking). Uses higher multiplier when client-side
 * filtering or reranking will further reduce the result set.
 *
 * @param requestedLimit - The number of results the user wants
 * @param needsOverfetch - Whether extra overfetch is needed (pathPattern, rerank)
 * @returns The limit to use when querying Qdrant (minimum 20)
 */
export function calculateFetchLimit(
  requestedLimit: number,
  needsOverfetch: boolean,
): number {
  const multiplier = needsOverfetch ? 6 : 4;
  return Math.max(20, requestedLimit * multiplier);
}
```

Note: the third `multiplier` parameter is removed — no callers use custom
multipliers in production code.

**Step 4: Run tests to verify they pass**

Run:
`npx vitest run tests/qdrant/filters/glob.test.ts tests/mcp/tools/search.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/core/adapters/qdrant/filters/glob.ts tests/qdrant/filters/glob.test.ts tests/mcp/tools/search.test.ts
git commit -m "feat(search): raise candidate pool defaults to ×4/×6 with min 20

Unified calculateFetchLimit formula. Base multiplier ×4 (was ×1),
overfetch ×6 (was ×3). Minimum 20 candidates always.
Refs: tea-rags-mcp-47m"
```

---

### Task 2: Align hybridSearch contract — remove internal fetchLimit and slice

**Files:**

- Modify: `src/core/adapters/qdrant/client.ts:585-674`
- Modify: `tests/core/adapters/qdrant/client.test.ts` (hybridSearch describe
  block)

**Step 1: Update hybridSearch tests**

In `tests/core/adapters/qdrant/client.test.ts`, find the test "should use custom
limit with appropriate fetch limit" (line ~867) and update:

```typescript
it("should pass fetchLimit directly to Qdrant (no internal calculation)", async () => {
  mockParallelSearch([], []);

  await manager.hybridSearch("test-collection", denseVector, sparseVector, 40);

  // fetchLimit is passed through as-is — no internal multiplication
  expect(mockClient.search).toHaveBeenCalledWith(
    "test-collection",
    expect.objectContaining({ limit: 40 }),
  );
});
```

Find the default-limit test (line ~817) — the one calling `hybridSearch` without
limit. Update it to verify the default fetchLimit is used as-is:

```typescript
const results = await manager.hybridSearch(
  "test-collection",
  denseVector,
  sparseVector,
  20,
);
```

Add a test that hybridSearch returns ALL fused results (no internal slice):

```typescript
it("should return all fused results without slicing", async () => {
  // 3 dense + 2 sparse = up to 4 unique after merge (one overlap)
  mockParallelSearch(
    [
      { id: "a", score: 0.9, payload: { text: "dense-1" } },
      { id: "b", score: 0.8, payload: { text: "dense-2" } },
      { id: "c", score: 0.7, payload: { text: "dense-3" } },
    ],
    [
      { id: "b", score: 0.9, payload: { text: "sparse-overlap" } },
      { id: "d", score: 0.8, payload: { text: "sparse-only" } },
    ],
  );

  // fetchLimit=20 but we have 4 unique results — all should be returned
  const results = await manager.hybridSearch(
    "test-collection",
    denseVector,
    sparseVector,
    20,
  );
  expect(results).toHaveLength(4);
  expect(results.map((r) => r.id).sort()).toEqual(["a", "b", "c", "d"]);
});
```

**Step 2: Run tests to verify they fail**

Run:
`npx vitest run tests/core/adapters/qdrant/client.test.ts -t "hybridSearch"`
Expected: FAIL — old code still has internal fetchLimit and slice

**Step 3: Update hybridSearch implementation**

In `src/core/adapters/qdrant/client.ts`, update the `hybridSearch` method (lines
585-674):

1. Rename parameter `limit = 5` → `fetchLimit: number`
2. Remove line 612: `const fetchLimit = Math.max(20, limit * 4);`
3. Replace line 669: `return merged.slice(0, limit);` → `return merged;`

The method signature becomes:

```typescript
async hybridSearch(
  collectionName: string,
  denseVector: number[],
  sparseVector: SparseVector,
  fetchLimit: number,
  filter?: Record<string, unknown>,
  semanticWeight = 0.7,
): Promise<SearchResult[]> {
```

And at line 667-669, change:

```typescript
// Sort by fused score descending
merged.sort((a, b) => b.score - a.score);
return merged;
```

**Step 4: Run tests to verify they pass**

Run:
`npx vitest run tests/core/adapters/qdrant/client.test.ts -t "hybridSearch"`
Expected: PASS

**Step 5: Run full test suite**

Run: `npx vitest run` Expected: PASS — callers already pass fetchLimit from
calculateFetchLimit and slice results themselves

**Step 6: Commit**

```bash
git add src/core/adapters/qdrant/client.ts tests/core/adapters/qdrant/client.test.ts
git commit -m "refactor(qdrant): align hybridSearch contract with search()

hybridSearch now receives fetchLimit from caller (no internal calculation)
and returns all fused results (no internal slice). Callers control both
pool sizing and final truncation.
Refs: tea-rags-mcp-47m"
```

---

### Task 3: Verify integration — full test suite + manual smoke check

**Files:**

- No code changes — verification only

**Step 1: Run full test suite**

Run: `npx vitest run` Expected: ALL PASS

**Step 2: Type-check**

Run: `npx tsc --noEmit` Expected: No errors

**Step 3: Close beads issue**

```bash
bd close tea-rags-mcp-47m --reason="Unified calculateFetchLimit (×4 base, ×6 overfetch, min 20). hybridSearch contract aligned with search()."
bd sync
```
