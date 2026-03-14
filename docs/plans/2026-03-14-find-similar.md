# find_similar Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development
> (if subagents available) or superpowers:executing-plans to implement this plan.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `find_similar` MCP tool that finds similar code chunks by ID or
raw code block, with positive/negative examples and reranking.

**Architecture:** New `SimilarSearchStrategy` extending `BaseExploreStrategy`,
using Qdrant `query()` API with `recommend` sub-query. Code blocks are embedded
on-the-fly via `EmbeddingProvider.embedBatch()`. Strategy is per-request (not
cached in constructor) because it needs positive/negative inputs per call.

**Tech Stack:** Qdrant `query()` API, `@qdrant/js-client-rest`, Zod schemas,
vitest.

**Spec:** `docs/specs/2026-03-14-find-similar-design.md`

---

## Chunk 1: Infrastructure — QdrantManager.query()

### Task 1: QdrantManager.query() method

**Files:**
- Test: `tests/core/adapters/qdrant/query.test.ts`
- Modify: `src/core/adapters/qdrant/client.ts`

- [ ] **Step 1: Write failing test — basic query call**

```typescript
// tests/core/adapters/qdrant/query.test.ts
import { describe, expect, it, vi } from "vitest";
import { QdrantManager } from "../../../../src/core/adapters/qdrant/client.js";

// Mock the Qdrant client
const mockQuery = vi.fn();
const mockGetCollectionInfo = vi.fn();

function createManager(): QdrantManager {
  const manager = new QdrantManager("http://localhost:6333");
  // Replace internal client with mock
  (manager as any).client = { query: mockQuery };
  // Replace getCollectionInfo to control hybridEnabled
  manager.getCollectionInfo = mockGetCollectionInfo;
  return manager;
}

describe("QdrantManager.query()", () => {
  it("calls client.query with recommend sub-query", async () => {
    mockGetCollectionInfo.mockResolvedValue({ hybridEnabled: false });
    mockQuery.mockResolvedValue({
      points: [
        { id: "uuid-1", score: 0.95, payload: { relativePath: "src/a.ts" } },
        { id: "uuid-2", score: 0.85, payload: { relativePath: "src/b.ts" } },
      ],
    });

    const manager = createManager();
    const results = await manager.query("test_col", {
      positive: ["id-1", [0.1, 0.2, 0.3]],
      negative: ["id-2"],
      strategy: "best_score",
      limit: 10,
      filter: { must: [{ key: "language", match: { value: "typescript" } }] },
    });

    expect(mockQuery).toHaveBeenCalledWith("test_col", expect.objectContaining({
      query: {
        recommend: {
          positive: ["id-1", [0.1, 0.2, 0.3]],
          negative: ["id-2"],
          strategy: "best_score",
        },
      },
      limit: 10,
      filter: { must: [{ key: "language", match: { value: "typescript" } }] },
      with_payload: true,
      with_vector: false,
    }));
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      id: "uuid-1",
      score: 0.95,
      payload: { relativePath: "src/a.ts" },
    });
  });

  it("sets using='dense' for hybrid-enabled collections", async () => {
    mockGetCollectionInfo.mockResolvedValue({ hybridEnabled: true });
    mockQuery.mockResolvedValue({ points: [] });

    const manager = createManager();
    await manager.query("hybrid_col", {
      positive: ["id-1"],
      limit: 5,
    });

    expect(mockQuery).toHaveBeenCalledWith("hybrid_col", expect.objectContaining({
      using: "dense",
    }));
  });

  it("omits using for non-hybrid collections", async () => {
    mockGetCollectionInfo.mockResolvedValue({ hybridEnabled: false });
    mockQuery.mockResolvedValue({ points: [] });

    const manager = createManager();
    await manager.query("plain_col", {
      positive: ["id-1"],
      limit: 5,
    });

    const callArgs = mockQuery.mock.calls[0][1];
    expect(callArgs.using).toBeUndefined();
  });

  it("handles empty results", async () => {
    mockGetCollectionInfo.mockResolvedValue({ hybridEnabled: false });
    mockQuery.mockResolvedValue({ points: [] });

    const manager = createManager();
    const results = await manager.query("test_col", {
      positive: ["id-1"],
      limit: 5,
    });

    expect(results).toEqual([]);
  });

  it("passes offset when provided", async () => {
    mockGetCollectionInfo.mockResolvedValue({ hybridEnabled: false });
    mockQuery.mockResolvedValue({ points: [] });

    const manager = createManager();
    await manager.query("test_col", {
      positive: ["id-1"],
      limit: 10,
      offset: 5,
    });

    expect(mockQuery).toHaveBeenCalledWith("test_col", expect.objectContaining({
      offset: 5,
    }));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/core/adapters/qdrant/query.test.ts
```

Expected: FAIL — `manager.query is not a function`

- [ ] **Step 3: Implement QdrantManager.query()**

Add to `src/core/adapters/qdrant/client.ts` after `getPoint()` method (after
line ~372):

```typescript
/**
 * Query using Qdrant's universal query() API with recommend sub-query.
 * Used by find_similar to find chunks similar to given IDs or vectors.
 */
async query(
  collectionName: string,
  options: {
    positive: (string | number | number[])[];
    negative?: (string | number | number[])[];
    strategy?: "best_score" | "average_vector" | "sum_scores";
    limit: number;
    offset?: number;
    filter?: Record<string, unknown>;
  },
): Promise<{ id: string | number; score: number; payload?: Record<string, unknown> }[]> {
  const collectionInfo = await this.getCollectionInfo(collectionName);

  const recommend: Record<string, unknown> = {
    positive: options.positive,
  };
  if (options.negative?.length) recommend.negative = options.negative;
  if (options.strategy) recommend.strategy = options.strategy;

  const queryParams: Record<string, unknown> = {
    query: { recommend },
    limit: options.limit,
    with_payload: true,
    with_vector: false,
  };

  if (options.offset !== undefined) queryParams.offset = options.offset;
  if (options.filter) queryParams.filter = options.filter;
  if (collectionInfo.hybridEnabled) queryParams.using = "dense";

  const response = await this.client.query(
    collectionName,
    queryParams as any,
  );

  return (response.points ?? []).map((point) => ({
    id: point.id,
    score: point.score,
    payload: (point.payload as Record<string, unknown>) || undefined,
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/core/adapters/qdrant/query.test.ts
```

Expected: PASS

- [ ] **Step 5: Type check**

```bash
npx tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add tests/core/adapters/qdrant/query.test.ts src/core/adapters/qdrant/client.ts
git commit -m "feat(explore): add QdrantManager.query() for recommend API"
```

---

## Chunk 2: DTO + Strategy + Facade wiring

### Task 2: FindSimilarRequest DTO

**Files:**
- Modify: `src/core/api/public/dto/explore.ts`
- Modify: `src/core/api/public/dto/index.ts`

- [ ] **Step 1: Add FindSimilarRequest to explore.ts**

Add after `ExploreCodeRequest` (after line 93):

```typescript
/**
 * Find similar code chunks by ID or raw code block.
 * Uses Qdrant query() API with recommend sub-query.
 */
export interface FindSimilarRequest extends CollectionRef {
  positiveIds?: string[];
  positiveCode?: string[];
  negativeIds?: string[];
  negativeCode?: string[];
  strategy?: "best_score" | "average_vector" | "sum_scores";
  filter?: Record<string, unknown>;
  pathPattern?: string;
  fileExtensions?: string[];
  rerank?: string | { custom: Record<string, number> };
  limit?: number;
  offset?: number;
  metaOnly?: boolean;
}
```

- [ ] **Step 2: Add re-export to dto/index.ts**

Add `FindSimilarRequest` to the Explore export block in `dto/index.ts`:

```typescript
export type {
  // Explore
  CollectionRef,
  TypedFilterParams,
  SemanticSearchRequest,
  HybridSearchRequest,
  RankChunksRequest,
  ExploreCodeRequest,
  FindSimilarRequest,  // ← add
  SearchResult,
  ExploreResponse,
  SignalDescriptor,
  PresetDescriptors,
} from "./explore.js";
```

- [ ] **Step 3: Type check**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add src/core/api/public/dto/explore.ts src/core/api/public/dto/index.ts
git commit -m "feat(explore): add FindSimilarRequest DTO"
```

### Task 3: SimilarSearchStrategy

**Files:**
- Test: `tests/core/domains/explore/strategies/similar.test.ts`
- Create: `src/core/domains/explore/strategies/similar.ts`
- Modify: `src/core/domains/explore/strategies/types.ts` (type union)
- Modify: `src/core/domains/explore/strategies/index.ts` (barrel)
- Modify: `src/core/domains/explore/index.ts` (barrel)

- [ ] **Step 1: Write failing test**

```typescript
// tests/core/domains/explore/strategies/similar.test.ts
import { describe, expect, it, vi } from "vitest";

import type { EmbeddingProvider } from "../../../../../src/core/adapters/embeddings/base.js";
import type { QdrantManager } from "../../../../../src/core/adapters/qdrant/client.js";
import type { Reranker } from "../../../../../src/core/domains/explore/reranker.js";
import { SimilarSearchStrategy } from "../../../../../src/core/domains/explore/strategies/similar.js";

const mockReranker = { rerank: vi.fn((r: unknown[]) => r) } as unknown as Reranker;

function createMockQdrant(
  queryResults: { id: string | number; score: number; payload?: Record<string, unknown> }[] = [],
): QdrantManager {
  return {
    query: vi.fn().mockResolvedValue(queryResults),
  } as unknown as QdrantManager;
}

function createMockEmbeddings(): EmbeddingProvider {
  return {
    embedBatch: vi.fn().mockResolvedValue([
      { embedding: [0.1, 0.2, 0.3], dimensions: 3 },
    ]),
    embed: vi.fn(),
    getDimensions: vi.fn().mockReturnValue(3),
    getModel: vi.fn().mockReturnValue("test-model"),
  } as unknown as EmbeddingProvider;
}

function createStrategy(opts?: {
  qdrant?: QdrantManager;
  embeddings?: EmbeddingProvider;
  positiveIds?: string[];
  positiveCode?: string[];
  negativeIds?: string[];
  negativeCode?: string[];
  strategy?: "best_score" | "average_vector" | "sum_scores";
  fileExtensions?: string[];
}) {
  return new SimilarSearchStrategy(
    opts?.qdrant ?? createMockQdrant(),
    mockReranker,
    [],
    [],
    opts?.embeddings ?? createMockEmbeddings(),
    {
      positiveIds: opts?.positiveIds ?? ["uuid-1"],
      positiveCode: opts?.positiveCode,
      negativeIds: opts?.negativeIds,
      negativeCode: opts?.negativeCode,
      strategy: opts?.strategy,
      fileExtensions: opts?.fileExtensions,
    },
  );
}

describe("SimilarSearchStrategy", () => {
  it("has type 'similar'", () => {
    expect(createStrategy().type).toBe("similar");
  });

  it("passes positiveIds directly to qdrant.query", async () => {
    const qdrant = createMockQdrant([
      { id: "r1", score: 0.9, payload: { relativePath: "a.ts" } },
    ]);
    const strategy = createStrategy({ qdrant, positiveIds: ["uuid-1", "uuid-2"] });

    await strategy.execute({ collectionName: "col", limit: 10 });

    expect(qdrant.query).toHaveBeenCalledWith("col", expect.objectContaining({
      positive: expect.arrayContaining(["uuid-1", "uuid-2"]),
    }));
  });

  it("embeds positiveCode and merges with positiveIds", async () => {
    const embeddings = createMockEmbeddings();
    (embeddings.embedBatch as ReturnType<typeof vi.fn>).mockResolvedValue([
      { embedding: [0.5, 0.6, 0.7], dimensions: 3 },
    ]);
    const qdrant = createMockQdrant();
    const strategy = createStrategy({
      qdrant,
      embeddings,
      positiveIds: ["uuid-1"],
      positiveCode: ["function foo() {}"],
    });

    await strategy.execute({ collectionName: "col", limit: 10 });

    expect(embeddings.embedBatch).toHaveBeenCalledWith(["function foo() {}"]);
    expect(qdrant.query).toHaveBeenCalledWith("col", expect.objectContaining({
      positive: ["uuid-1", [0.5, 0.6, 0.7]],
    }));
  });

  it("embeds negativeCode and merges with negativeIds", async () => {
    const embeddings = createMockEmbeddings();
    (embeddings.embedBatch as ReturnType<typeof vi.fn>).mockResolvedValue([
      { embedding: [0.9, 0.8, 0.7], dimensions: 3 },
    ]);
    const qdrant = createMockQdrant();
    const strategy = createStrategy({
      qdrant,
      embeddings,
      negativeIds: ["neg-1"],
      negativeCode: ["bad pattern"],
    });

    await strategy.execute({ collectionName: "col", limit: 10 });

    expect(qdrant.query).toHaveBeenCalledWith("col", expect.objectContaining({
      negative: ["neg-1", [0.9, 0.8, 0.7]],
    }));
  });

  it("skips empty code blocks", async () => {
    const embeddings = createMockEmbeddings();
    const strategy = createStrategy({
      embeddings,
      positiveCode: ["", "  ", "valid code"],
    });

    await strategy.execute({ collectionName: "col", limit: 10 });

    expect(embeddings.embedBatch).toHaveBeenCalledWith(["valid code"]);
  });

  it("passes strategy to qdrant.query", async () => {
    const qdrant = createMockQdrant();
    const strategy = createStrategy({ qdrant, strategy: "average_vector" });

    await strategy.execute({ collectionName: "col", limit: 10 });

    expect(qdrant.query).toHaveBeenCalledWith("col", expect.objectContaining({
      strategy: "average_vector",
    }));
  });

  it("converts fileExtensions to Qdrant filter with match.any", async () => {
    const qdrant = createMockQdrant();
    const strategy = createStrategy({
      qdrant,
      fileExtensions: [".ts", ".js"],
    });

    await strategy.execute({
      collectionName: "col",
      limit: 10,
    });

    const callArgs = (qdrant.query as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(callArgs.filter).toEqual({
      must: [
        { key: "fileExtension", match: { any: [".ts", ".js"] } },
      ],
    });
  });

  it("merges fileExtensions filter with user-provided filter", async () => {
    const qdrant = createMockQdrant();
    const strategy = createStrategy({
      qdrant,
      fileExtensions: [".ts"],
    });

    await strategy.execute({
      collectionName: "col",
      limit: 10,
      filter: { must: [{ key: "language", match: { value: "typescript" } }] },
    });

    const callArgs = (qdrant.query as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(callArgs.filter).toEqual({
      must: [
        { key: "language", match: { value: "typescript" } },
        { key: "fileExtension", match: { any: [".ts"] } },
      ],
    });
  });

  it("does not embed when only IDs provided", async () => {
    const embeddings = createMockEmbeddings();
    const strategy = createStrategy({
      embeddings,
      positiveIds: ["uuid-1"],
      positiveCode: undefined,
      negativeCode: undefined,
    });

    await strategy.execute({ collectionName: "col", limit: 10 });

    expect(embeddings.embedBatch).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/core/domains/explore/strategies/similar.test.ts
```

Expected: FAIL — cannot resolve `similar.js`

- [ ] **Step 3: Update strategy type union**

In `src/core/domains/explore/strategies/types.ts`, change line 34:

```typescript
// Before:
readonly type: "vector" | "hybrid" | "scroll-rank";
// After:
readonly type: "vector" | "hybrid" | "scroll-rank" | "similar";
```

Also update `BaseExploreStrategy` in `base.ts` line 18:

```typescript
abstract readonly type: "vector" | "hybrid" | "scroll-rank" | "similar";
```

- [ ] **Step 4: Implement SimilarSearchStrategy**

Create `src/core/domains/explore/strategies/similar.ts`:

```typescript
/**
 * SimilarSearchStrategy — find similar chunks via Qdrant recommend API.
 *
 * Unlike other strategies (cached in ExploreFacade constructor), this is
 * created per-request because it needs positive/negative inputs per call.
 */

import type { EmbeddingProvider } from "../../../adapters/embeddings/base.js";
import type { QdrantManager } from "../../../adapters/qdrant/client.js";
import type { PayloadSignalDescriptor } from "../../../contracts/types/trajectory.js";
import type { Reranker } from "../reranker.js";
import { BaseExploreStrategy } from "./base.js";
import type { ExploreContext, ExploreResult } from "./types.js";

export interface SimilarSearchInput {
  positiveIds?: string[];
  positiveCode?: string[];
  negativeIds?: string[];
  negativeCode?: string[];
  strategy?: "best_score" | "average_vector" | "sum_scores";
  fileExtensions?: string[];
}

export class SimilarSearchStrategy extends BaseExploreStrategy {
  readonly type = "similar" as const;

  constructor(
    qdrant: QdrantManager,
    reranker: Reranker,
    payloadSignals: PayloadSignalDescriptor[],
    essentialKeys: string[],
    private readonly embeddings: EmbeddingProvider,
    private readonly input: SimilarSearchInput,
  ) {
    super(qdrant, reranker, payloadSignals, essentialKeys);
  }

  protected async executeExplore(ctx: ExploreContext): Promise<ExploreResult[]> {
    // 1. Collect code blocks to embed (filter empty strings)
    const positiveCodeBlocks = (this.input.positiveCode ?? []).filter((c) => c.trim().length > 0);
    const negativeCodeBlocks = (this.input.negativeCode ?? []).filter((c) => c.trim().length > 0);
    const allCodeBlocks = [...positiveCodeBlocks, ...negativeCodeBlocks];

    // 2. Embed all code blocks in one batch
    let embeddedVectors: number[][] = [];
    if (allCodeBlocks.length > 0) {
      const results = await this.embeddings.embedBatch(allCodeBlocks);
      embeddedVectors = results.map((r) => r.embedding);
    }

    // 3. Split embedded vectors back into positive/negative
    const positiveVectors = embeddedVectors.slice(0, positiveCodeBlocks.length);
    const negativeVectors = embeddedVectors.slice(positiveCodeBlocks.length);

    // 4. Build positive/negative arrays (IDs + vectors)
    const positive: (string | number[])[] = [
      ...(this.input.positiveIds ?? []),
      ...positiveVectors,
    ];
    const negative: (string | number[])[] = [
      ...(this.input.negativeIds ?? []),
      ...negativeVectors,
    ];

    // 5. Build filter (merge user filter + fileExtensions)
    const filter = this.buildFilter(ctx.filter, this.input.fileExtensions);

    // 6. Call Qdrant query
    return this.qdrant.query(ctx.collectionName, {
      positive,
      negative: negative.length > 0 ? negative : undefined,
      strategy: this.input.strategy ?? "best_score",
      limit: ctx.limit,
      offset: ctx.offset,
      filter,
    });
  }

  private buildFilter(
    userFilter?: Record<string, unknown>,
    fileExtensions?: string[],
  ): Record<string, unknown> | undefined {
    const extensionCondition = fileExtensions?.length
      ? { key: "fileExtension", match: { any: fileExtensions } }
      : undefined;

    if (!userFilter && !extensionCondition) return undefined;

    const mustClauses: unknown[] = [];

    // Merge existing must clauses from user filter
    if (userFilter) {
      if (Array.isArray(userFilter.must)) {
        mustClauses.push(...userFilter.must);
      } else if (!userFilter.must && !userFilter.should && !userFilter.must_not) {
        // Simple key-value filter — pass through as-is with extension appended
        // But we need to convert to must format
        const entries = Object.entries(userFilter).map(([key, value]) => ({
          key,
          match: { value },
        }));
        mustClauses.push(...entries);
      }
    }

    if (extensionCondition) {
      mustClauses.push(extensionCondition);
    }

    if (mustClauses.length === 0) return userFilter;

    // Preserve should/must_not from user filter
    const result: Record<string, unknown> = { must: mustClauses };
    if (userFilter?.should) result.should = userFilter.should;
    if (userFilter?.must_not) result.must_not = userFilter.must_not;
    return result;
  }
}
```

- [ ] **Step 5: Update barrel exports**

`src/core/domains/explore/strategies/index.ts` — add:

```typescript
export { SimilarSearchStrategy } from "./similar.js";
export type { SimilarSearchInput } from "./similar.js";
```

`src/core/domains/explore/index.ts` — add:

```typescript
export { SimilarSearchStrategy } from "./strategies/index.js";
export type { SimilarSearchInput } from "./strategies/index.js";
```

- [ ] **Step 6: Run test to verify it passes**

```bash
npx vitest run tests/core/domains/explore/strategies/similar.test.ts
```

Expected: PASS

- [ ] **Step 7: Run full test suite**

```bash
npx vitest run
```

Expected: all green (existing tests should not break)

- [ ] **Step 8: Commit**

```bash
git add src/core/domains/explore/strategies/similar.ts \
  src/core/domains/explore/strategies/types.ts \
  src/core/domains/explore/strategies/base.ts \
  src/core/domains/explore/strategies/index.ts \
  src/core/domains/explore/index.ts \
  tests/core/domains/explore/strategies/similar.test.ts
git commit -m "feat(explore): add SimilarSearchStrategy for recommend API"
```

### Task 4: ExploreFacade.findSimilar() + App wiring

**Files:**
- Test: `tests/core/api/internal/facades/find-similar.test.ts`
- Modify: `src/core/api/internal/facades/explore-facade.ts`
- Modify: `src/core/api/public/app.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/core/api/internal/facades/find-similar.test.ts
import { describe, expect, it, vi } from "vitest";

import type { EmbeddingProvider } from "../../../../../src/core/adapters/embeddings/base.js";
import type { QdrantManager } from "../../../../../src/core/adapters/qdrant/client.js";
import type { TrajectoryRegistry } from "../../../../../src/core/contracts/types/trajectory.js";
import type { Reranker } from "../../../../../src/core/domains/explore/reranker.js";
import { ExploreFacade } from "../../../../../src/core/api/internal/facades/explore-facade.js";

function createMockDeps() {
  const qdrant = {
    collectionExists: vi.fn().mockResolvedValue(true),
    search: vi.fn().mockResolvedValue([]),
    hybridSearch: vi.fn().mockResolvedValue([]),
    scrollOrdered: vi.fn().mockResolvedValue([]),
    query: vi.fn().mockResolvedValue([
      { id: "r1", score: 0.9, payload: { relativePath: "src/a.ts" } },
    ]),
    getCollectionInfo: vi.fn().mockResolvedValue({ hybridEnabled: false }),
  } as unknown as QdrantManager;

  const embeddings = {
    embed: vi.fn().mockResolvedValue({ embedding: [0.1, 0.2, 0.3], dimensions: 3 }),
    embedBatch: vi.fn().mockResolvedValue([]),
    getDimensions: vi.fn().mockReturnValue(3),
    getModel: vi.fn().mockReturnValue("test"),
  } as unknown as EmbeddingProvider;

  const reranker = {
    rerank: vi.fn((r: unknown[]) => r),
    getPresetNames: vi.fn().mockReturnValue(["relevance"]),
    getPreset: vi.fn(),
    getDescriptors: vi.fn().mockReturnValue([]),
    getDescriptorInfo: vi.fn().mockReturnValue([]),
    hasCollectionStats: false,
    setCollectionStats: vi.fn(),
  } as unknown as Reranker;

  const registry = {
    buildMergedFilter: vi.fn().mockReturnValue(undefined),
    getAllPayloadSignalDescriptors: vi.fn().mockReturnValue([]),
    getEssentialPayloadKeys: vi.fn().mockReturnValue([]),
    getAllPresets: vi.fn().mockReturnValue([]),
    getAllDerivedSignals: vi.fn().mockReturnValue([]),
    getAllFilters: vi.fn().mockReturnValue([]),
  } as unknown as TrajectoryRegistry;

  return { qdrant, embeddings, reranker, registry };
}

describe("ExploreFacade.findSimilar()", () => {
  it("returns results from SimilarSearchStrategy", async () => {
    const deps = createMockDeps();
    const facade = new ExploreFacade(deps);

    const response = await facade.findSimilar({
      collection: "test_col",
      positiveIds: ["uuid-1"],
    });

    expect(response.results).toHaveLength(1);
    expect(response.results[0].id).toBe("r1");
    expect(response.results[0].score).toBe(0.9);
  });

  it("throws when no inputs provided at all", async () => {
    const deps = createMockDeps();
    const facade = new ExploreFacade(deps);

    await expect(
      facade.findSimilar({ collection: "test_col" }),
    ).rejects.toThrow("At least one positive or negative input is required");
  });

  it("throws when average_vector used with zero positives", async () => {
    const deps = createMockDeps();
    const facade = new ExploreFacade(deps);

    await expect(
      facade.findSimilar({
        collection: "test_col",
        negativeIds: ["neg-1"],
        strategy: "average_vector",
      }),
    ).rejects.toThrow("requires at least one positive");
  });

  it("allows best_score with negative-only (zero positives)", async () => {
    const deps = createMockDeps();
    const facade = new ExploreFacade(deps);

    const response = await facade.findSimilar({
      collection: "test_col",
      negativeIds: ["neg-1"],
      strategy: "best_score",
    });

    expect(response.results).toHaveLength(1);
  });

  it("passes embeddings to SimilarSearchStrategy for code embedding", async () => {
    const deps = createMockDeps();
    (deps.embeddings.embedBatch as ReturnType<typeof vi.fn>).mockResolvedValue([
      { embedding: [0.5, 0.6, 0.7], dimensions: 3 },
    ]);
    const facade = new ExploreFacade(deps);

    await facade.findSimilar({
      collection: "test_col",
      positiveCode: ["function foo() {}"],
    });

    expect(deps.embeddings.embedBatch).toHaveBeenCalledWith(["function foo() {}"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/core/api/internal/facades/find-similar.test.ts
```

Expected: FAIL — `facade.findSimilar is not a function`

- [ ] **Step 3: Implement ExploreFacade.findSimilar()**

Add to `src/core/api/internal/facades/explore-facade.ts`:

1. Import at top:

```typescript
import type { FindSimilarRequest } from "../../public/dto/index.js";
import { SimilarSearchStrategy } from "../../../domains/explore/strategies/similar.js";
```

2. Add method after `searchCode()` (before the private helpers section):

```typescript
/** Find similar chunks by ID or code block (find_similar MCP tool). */
async findSimilar(request: FindSimilarRequest): Promise<ExploreResponse> {
  // Count meaningful inputs
  const hasPositive =
    (request.positiveIds?.length ?? 0) > 0 ||
    (request.positiveCode?.filter((c) => c.trim().length > 0).length ?? 0) > 0;
  const hasNegative =
    (request.negativeIds?.length ?? 0) > 0 ||
    (request.negativeCode?.filter((c) => c.trim().length > 0).length ?? 0) > 0;

  // Validate: strategy-specific constraints
  const strategy = request.strategy ?? "best_score";
  if (strategy !== "best_score" && !hasPositive) {
    throw new Error(`Strategy '${strategy}' requires at least one positive input`);
  }
  // best_score allows negative-only, but must have at least something
  if (!hasPositive && !hasNegative) {
    throw new Error("At least one positive or negative input is required");
  }

  const { collectionName, path } = resolveCollection(request.collection, request.path);

  // Create per-request strategy
  const similarStrategy = new SimilarSearchStrategy(
    this.qdrant,
    this.reranker,
    this.payloadSignals,
    this.essentialKeys,
    this.embeddings,
    {
      positiveIds: request.positiveIds,
      positiveCode: request.positiveCode,
      negativeIds: request.negativeIds,
      negativeCode: request.negativeCode,
      strategy,
      fileExtensions: request.fileExtensions,
    },
  );

  return this.executeExplore(
    similarStrategy,
    {
      collectionName,
      limit: request.limit ?? 10,
      offset: request.offset,
      filter: request.filter,
      pathPattern: request.pathPattern,
      rerank: request.rerank,
      metaOnly: request.metaOnly,
    },
    path,
  );
}
```

**REQUIRED: Promote local variables to instance fields.** The existing constructor
has `const signals = deps.payloadSignals ?? []` and `const keys = deps.essentialKeys ?? []`
as local variables (lines 93-94). These must become instance fields so
`findSimilar()` can access them.

1. Add instance fields to the class (after the existing ones, around line 84):

```typescript
private readonly payloadSignals: PayloadSignalDescriptor[];
private readonly essentialKeys: string[];
```

2. In constructor, replace local `const signals`/`const keys` with `this.`:

```typescript
// Before:
const signals = deps.payloadSignals ?? [];
const keys = deps.essentialKeys ?? [];
this.vectorStrategy = createExploreStrategy("vector", deps.qdrant, deps.reranker, signals, keys);
this.hybridStrategy = createExploreStrategy("hybrid", deps.qdrant, deps.reranker, signals, keys);
this.scrollRankStrategy = createExploreStrategy("scroll-rank", deps.qdrant, deps.reranker, signals, keys);

// After:
this.payloadSignals = deps.payloadSignals ?? [];
this.essentialKeys = deps.essentialKeys ?? [];
this.vectorStrategy = createExploreStrategy("vector", deps.qdrant, deps.reranker, this.payloadSignals, this.essentialKeys);
this.hybridStrategy = createExploreStrategy("hybrid", deps.qdrant, deps.reranker, this.payloadSignals, this.essentialKeys);
this.scrollRankStrategy = createExploreStrategy("scroll-rank", deps.qdrant, deps.reranker, this.payloadSignals, this.essentialKeys);
```

- [ ] **Step 4: Wire in App interface and createApp()**

In `src/core/api/public/app.ts`:

1. Add import:

```typescript
import type { FindSimilarRequest } from "./dto/index.js";
```

2. Add method to `App` interface (line ~52, after `searchCode`):

```typescript
findSimilar: (request: FindSimilarRequest) => Promise<ExploreResponse>;
```

3. Add wiring in `createApp()` return object (line ~103, after `searchCode`):

```typescript
findSimilar: async (req) => deps.explore.findSimilar(req),
```

4. Add `"find_similar"` to the tools array in `getSchemaDescriptors` (line 124):

```typescript
const tools = ["semantic_search", "hybrid_search", "search_code", "rank_chunks", "find_similar"];
```

- [ ] **Step 5: Run test to verify it passes**

```bash
npx vitest run tests/core/api/internal/facades/find-similar.test.ts
```

Expected: PASS

- [ ] **Step 6: Type check + full test suite**

```bash
npx tsc --noEmit && npx vitest run
```

- [ ] **Step 7: Commit**

```bash
git add src/core/api/internal/facades/explore-facade.ts \
  src/core/api/public/app.ts \
  tests/core/api/internal/facades/find-similar.test.ts
git commit -m "feat(explore): add ExploreFacade.findSimilar() with App wiring"
```

---

## Chunk 3: Presets + MCP tool registration

> **IMPORTANT:** Preset tools[] update MUST happen before schema/tool
> registration, because `schemaBuilder.buildRerankSchema("find_similar")` calls
> `getPresetNames("find_similar")` which returns `[]` if no preset lists
> `find_similar` → throws "No presets registered".

### Task 5: Add find_similar to preset tools[] arrays

**Files:**
- Modify: all preset files that list `"semantic_search"` in their `tools[]`

- [ ] **Step 1: Find and update all preset files**

All presets that currently list `"semantic_search"` should also list
`"find_similar"` — the tool produces the same kind of scored chunks that benefit
from reranking.

```bash
grep -rn '"semantic_search"' src/core/domains/trajectory/*/rerank/presets/ --include="*.ts"
grep -rn '"semantic_search"' src/core/domains/explore/rerank/presets/ --include="*.ts"
```

For each preset file found, add `"find_similar"` to the `tools` array:

```typescript
// Before:
tools: ["semantic_search", "hybrid_search"],
// After:
tools: ["semantic_search", "hybrid_search", "find_similar"],
```

- [ ] **Step 2: Run full test suite**

```bash
npx vitest run
```

- [ ] **Step 3: Commit**

```bash
git add src/core/domains/trajectory/ src/core/domains/explore/rerank/
git commit -m "feat(presets): add find_similar to preset tools[] arrays"
```

### Task 6: Zod schema + tool registration

**Files:**
- Modify: `src/mcp/tools/schemas.ts`
- Modify: `src/mcp/tools/explore.ts`

- [ ] **Step 1: Add FindSimilarSchema to schemas.ts**

Add to `createSearchSchemas()` function (after `RankChunksSchema`, before
the return statement):

```typescript
const findSimilarRerankSchema = schemaBuilder.buildRerankSchema("find_similar");

const FindSimilarSchema = {
  ...collectionPathFields(),
  positiveIds: z
    .array(z.string())
    .optional()
    .describe(
      "Chunk IDs from previous search results to find similar code. " +
        "At least one positiveIds or positiveCode entry is required.",
    ),
  positiveCode: z
    .array(z.string())
    .optional()
    .describe(
      "Raw code blocks to find similar code. Embedded on-the-fly using the same model as indexing. " +
        "Use when you have generated code or a snippet and want to find similar patterns in the codebase.",
    ),
  negativeIds: z
    .array(z.string())
    .optional()
    .describe("Chunk IDs to push results away from (negative examples)."),
  negativeCode: z
    .array(z.string())
    .optional()
    .describe("Raw code blocks to push results away from (negative examples)."),
  strategy: z
    .enum(["best_score", "average_vector", "sum_scores"])
    .optional()
    .describe(
      "Recommend strategy. best_score (default): scores against each example independently, " +
        "supports negative-only. average_vector: averages positive vectors, fastest. " +
        "sum_scores: sums scores across examples.",
    ),
  filter: z
    .record(z.any())
    .optional()
    .describe(
      "Qdrant filter object with must/should/must_not conditions. " +
        "Available fields: relativePath, fileExtension, language, chunkType, " +
        "git.commitCount, git.ageDays, git.dominantAuthor, etc.",
    ),
  pathPattern: z
    .string()
    .optional()
    .describe(
      "Glob pattern for filtering by file path (client-side via picomatch). " +
        "Examples: '**/workflow/**', 'src/**/*.ts'.",
    ),
  fileExtensions: z
    .array(z.string())
    .optional()
    .describe("Filter by file extensions (e.g. ['.ts', '.js']). Shorthand for Qdrant fileExtension filter."),
  rerank: findSimilarRerankSchema
    .optional()
    .describe(
      "Reranking mode. Use presets like 'techDebt', 'hotspots', 'ownership' to re-score " +
        "results by signals beyond similarity. Default: 'relevance'.",
    ),
  limit: coerceNumber().optional().describe("Maximum number of results (default: 10)"),
  offset: z.coerce
    .number()
    .int()
    .min(0)
    .optional()
    .default(0)
    .describe("Skip first N results (for pagination). Default: 0."),
  metaOnly: coerceBoolean()
    .optional()
    .describe("Return only metadata (path, lines, git info) without content. Default: false."),
};
```

Update the return statement:

```typescript
return { SemanticSearchSchema, HybridSearchSchema, SearchCodeSchema, RankChunksSchema, FindSimilarSchema };
```

- [ ] **Step 2: Register find_similar tool in explore.ts**

Add after the `rank_chunks` registration (before closing `}`):

```typescript
// find_similar
server.registerTool(
  "find_similar",
  {
    title: "Find Similar",
    description:
      "Find code similar to given chunks or code blocks using Qdrant recommend API. " +
      "Provide chunk IDs from previous search results and/or raw code blocks as positive/negative examples. " +
      "Use for: exploring code patterns, finding duplicates, discovering related implementations, " +
      "or finding codebase matches for generated code.",
    inputSchema: searchSchemas.FindSimilarSchema,
  },
  async ({ positiveIds, positiveCode, negativeIds, negativeCode, strategy, rerank, ...rest }) => {
    try {
      const response = await app.findSimilar({
        ...rest,
        positiveIds,
        positiveCode,
        negativeIds,
        negativeCode,
        strategy,
        rerank: sanitizeRerank(rerank),
      });
      return appendDriftWarning(formatMcpResponse(response.results), response.driftWarning);
    } catch (error) {
      return formatMcpError(error instanceof Error ? error.message : String(error));
    }
  },
);
```

- [ ] **Step 3: Type check**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: Run full test suite**

```bash
npx vitest run
```

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools/schemas.ts src/mcp/tools/explore.ts
git commit -m "feat(mcp): register find_similar tool with Zod schema"
```

> Note: This task depends on Task 5 (presets). `buildRerankSchema("find_similar")`
> requires at least one preset to list `"find_similar"` in its `tools[]`.

---

## Chunk 4: Documentation + final verification

### Task 7: Update Docusaurus documentation

**Files:**
- Modify: `website/docs/api/tools.md`

- [ ] **Step 1: Add find_similar to tools reference page**

Add a new section for `find_similar` under Search Tools, including:
- Tool name and description
- All parameters with types, defaults, descriptions
- Example usage with positiveIds
- Example usage with positiveCode
- Example with mixed positive/negative

- [ ] **Step 2: Commit**

```bash
git add website/docs/api/tools.md
git commit -m "docs(api): add find_similar tool documentation"
```

### Task 8: Final verification

- [ ] **Step 1: Type check**

```bash
npx tsc --noEmit
```

- [ ] **Step 2: Full test suite**

```bash
npx vitest run
```

- [ ] **Step 3: Build**

```bash
npm run build
```

- [ ] **Step 4: Verify all changes committed**

```bash
git status
git log --oneline -10
```
