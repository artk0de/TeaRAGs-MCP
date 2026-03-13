# Explore Facade GRASP Refactoring — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development
> (if subagents available) or superpowers:executing-plans to implement this
> plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate copypasta in ExploreFacade by moving search pipeline logic
into strategy base class, killing legacy ExploreModule, and simplifying the
facade to a thin orchestrator.

**Architecture:** Strategies (already in `explore/strategies/`) gain an abstract
base class with shared defaults, postProcess, and metaOnly. The facade becomes a
thin pipeline: resolveCollection -> validateExists -> ensureStats ->
strategy.execute(ctx) -> toSearchResults -> checkDrift. ExploreModule is
deleted.

**Tech Stack:** TypeScript, Vitest, Qdrant client

**Spec:** `docs/superpowers/specs/2026-03-12-explore-facade-grasp-design.md`

---

## Chunk 1: Strategy Base Class

### Task 1: Add `rerank` and `metaOnly` to SearchContext

**Files:**

- Modify: `src/core/explore/strategies/types.ts`
- Test: `tests/core/explore/strategies/vector.test.ts` (verify existing tests
  still pass)

- [ ] **Step 1: Update SearchContext interface**

Add `rerank` and `metaOnly` fields to `SearchContext`:

```typescript
// In src/core/explore/strategies/types.ts
export interface SearchContext {
  collectionName: string;
  query?: string;
  embedding?: number[];
  sparseVector?: { indices: number[]; values: number[] };
  limit: number;
  filter?: Record<string, unknown>;
  weights?: Record<string, number>;
  level?: "chunk" | "file";
  presetName?: string;
  offset?: number;
  pathPattern?: string;
  rerank?: unknown; // RerankMode<string> — unknown to avoid circular deps
  metaOnly?: boolean;
}
```

- [ ] **Step 2: Run existing strategy tests**

Run: `npx vitest run tests/core/explore/strategies/`

Expected: All existing tests PASS (new optional fields don't break anything)

- [ ] **Step 3: Commit**

```bash
git add src/core/explore/strategies/types.ts
git commit -m "refactor(explore): add rerank and metaOnly to SearchContext"
```

---

### Task 2: Create BaseSearchStrategy abstract class

**Files:**

- Modify: `src/core/explore/strategies/types.ts`
- Test: `tests/core/explore/strategies/base.test.ts` (new)

- [ ] **Step 1: Write failing test for BaseSearchStrategy**

Create `tests/core/explore/strategies/base.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";

import type { PayloadSignalDescriptor } from "../../../../src/core/contracts/types/trajectory.js";
import {
  BaseSearchStrategy,
  type RawResult,
  type SearchContext,
} from "../../../../src/core/explore/strategies/types.js";

class TestStrategy extends BaseSearchStrategy {
  readonly type = "vector" as const;
  executeSearch = vi
    .fn<[SearchContext], Promise<RawResult[]>>()
    .mockResolvedValue([
      {
        id: "1",
        score: 0.9,
        payload: { relativePath: "a.ts", content: "hello" },
      },
      {
        id: "2",
        score: 0.7,
        payload: { relativePath: "b.ts", content: "world" },
      },
    ]);
}

const mockReranker = {
  rerank: vi.fn((results: any[]) => results),
} as any;

const PAYLOAD_SIGNALS: PayloadSignalDescriptor[] = [
  { key: "relativePath", type: "string", description: "Relative file path" },
  { key: "startLine", type: "number", description: "Start line" },
];

describe("BaseSearchStrategy", () => {
  it("applies default limit of 5 when not specified", async () => {
    const strategy = new TestStrategy(
      {} as any,
      mockReranker,
      PAYLOAD_SIGNALS,
      [],
    );
    await strategy.execute({ collectionName: "col", limit: 0 });
    // executeSearch receives context with computed fetchLimit
    const ctx = strategy.executeSearch.mock.calls[0][0];
    expect(ctx.limit).toBeGreaterThanOrEqual(5);
  });

  it("computes overfetch when pathPattern present", async () => {
    const strategy = new TestStrategy(
      {} as any,
      mockReranker,
      PAYLOAD_SIGNALS,
      [],
    );
    await strategy.execute({
      collectionName: "col",
      limit: 5,
      pathPattern: "src/**",
    });
    const ctx = strategy.executeSearch.mock.calls[0][0];
    // Overfetch should be > requested limit
    expect(ctx.limit).toBeGreaterThan(5);
  });

  it("applies postProcess (glob filter + trim) after executeSearch", async () => {
    const strategy = new TestStrategy(
      {} as any,
      mockReranker,
      PAYLOAD_SIGNALS,
      [],
    );
    strategy.executeSearch.mockResolvedValue([
      { id: "1", score: 0.9, payload: { relativePath: "src/a.ts" } },
      { id: "2", score: 0.8, payload: { relativePath: "lib/b.ts" } },
      { id: "3", score: 0.7, payload: { relativePath: "src/c.ts" } },
    ]);

    const results = await strategy.execute({
      collectionName: "col",
      limit: 10,
      pathPattern: "src/**",
    });

    // lib/b.ts should be filtered out by glob
    expect(results.every((r) => r.payload?.relativePath !== "lib/b.ts")).toBe(
      true,
    );
  });

  it("trims results to requested limit", async () => {
    const strategy = new TestStrategy(
      {} as any,
      mockReranker,
      PAYLOAD_SIGNALS,
      [],
    );
    strategy.executeSearch.mockResolvedValue(
      Array.from({ length: 20 }, (_, i) => ({
        id: String(i),
        score: 1 - i * 0.01,
        payload: { relativePath: `file${i}.ts` },
      })),
    );

    const results = await strategy.execute({ collectionName: "col", limit: 3 });
    expect(results).toHaveLength(3);
  });

  it("does not apply metaOnly by default", async () => {
    const strategy = new TestStrategy(
      {} as any,
      mockReranker,
      PAYLOAD_SIGNALS,
      [],
    );
    const results = await strategy.execute({ collectionName: "col", limit: 5 });
    // Full results should have payload with content
    expect(results[0].payload).toHaveProperty("content");
  });

  it("applies metaOnly when ctx.metaOnly is true", async () => {
    const strategy = new TestStrategy(
      {} as any,
      mockReranker,
      PAYLOAD_SIGNALS,
      [],
    );
    const results = await strategy.execute({
      collectionName: "col",
      limit: 5,
      metaOnly: true,
    });
    // metaOnly results should NOT have content field in payload
    expect(results[0].payload).not.toHaveProperty("content");
    // But should have metadata fields
    expect(results[0].payload).toHaveProperty("relativePath");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/explore/strategies/base.test.ts`

Expected: FAIL — `BaseSearchStrategy` does not exist yet

- [ ] **Step 3: Implement BaseSearchStrategy**

In `src/core/explore/strategies/types.ts`, add below the `SearchStrategy`
interface:

```typescript
import type { QdrantManager } from "../../adapters/qdrant/client.js";
import {
  calculateFetchLimit,
  filterResultsByGlob,
} from "../../adapters/qdrant/filters/index.js";
import type { PayloadSignalDescriptor } from "../../contracts/types/trajectory.js";
import { filterMetaOnly } from "../post-process.js";
import type { Reranker, RerankMode } from "../reranker.js";

export abstract class BaseSearchStrategy {
  constructor(
    protected readonly qdrant: QdrantManager,
    protected readonly reranker: Reranker,
    protected readonly payloadSignals: PayloadSignalDescriptor[],
    protected readonly essentialKeys: string[],
  ) {}

  abstract readonly type: "vector" | "hybrid" | "scroll-rank";
  abstract executeSearch(ctx: SearchContext): Promise<RawResult[]>;

  async execute(ctx: SearchContext): Promise<RawResult[]> {
    const prepared = this.applyDefaults(ctx);
    const results = await this.executeSearch(prepared);
    return this.postProcess(results, ctx);
  }

  protected applyDefaults(ctx: SearchContext): SearchContext {
    const requestedLimit = ctx.limit || 5;
    const needsOverfetch =
      Boolean(ctx.pathPattern) ||
      Boolean(ctx.rerank && ctx.rerank !== "relevance");
    const fetchLimit = calculateFetchLimit(requestedLimit, needsOverfetch);
    return { ...ctx, limit: fetchLimit };
  }

  protected postProcess(
    results: RawResult[],
    originalCtx: SearchContext,
  ): RawResult[] {
    const requestedLimit = originalCtx.limit || 5;
    let filtered = originalCtx.pathPattern
      ? filterResultsByGlob(results, originalCtx.pathPattern)
      : results;

    if (originalCtx.rerank && originalCtx.rerank !== "relevance") {
      filtered = this.reranker.rerank(
        filtered,
        originalCtx.rerank as RerankMode<string>,
        "semantic_search",
      );
    }

    filtered = filtered.slice(0, requestedLimit);

    if (originalCtx.metaOnly) {
      return this.applyMetaOnly(filtered);
    }

    return filtered;
  }

  protected applyMetaOnly(results: RawResult[]): RawResult[] {
    const metaResults = filterMetaOnly(
      results as any,
      this.payloadSignals,
      this.essentialKeys,
    );
    return metaResults.map((meta) => ({
      id: "",
      score: (meta.score as number) ?? 0,
      payload: meta,
    }));
  }
}
```

Note: keep the `SearchStrategy` interface for backward compat — existing tests
use it. `BaseSearchStrategy implements SearchStrategy`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/explore/strategies/base.test.ts`

Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/explore/strategies/types.ts tests/core/explore/strategies/base.test.ts
git commit -m "refactor(explore): add BaseSearchStrategy with shared defaults, postProcess, metaOnly"
```

---

### Task 3: Migrate VectorSearchStrategy to extend BaseSearchStrategy

**Files:**

- Modify: `src/core/explore/strategies/vector.ts`
- Modify: `tests/core/explore/strategies/vector.test.ts`

- [ ] **Step 1: Update VectorSearchStrategy to extend base class**

```typescript
import type { QdrantManager } from "../../adapters/qdrant/client.js";
import type { PayloadSignalDescriptor } from "../../contracts/types/trajectory.js";
import type { Reranker } from "../reranker.js";
import {
  BaseSearchStrategy,
  type RawResult,
  type SearchContext,
} from "./types.js";

export class VectorSearchStrategy extends BaseSearchStrategy {
  readonly type = "vector" as const;

  constructor(
    qdrant: QdrantManager,
    reranker: Reranker,
    payloadSignals: PayloadSignalDescriptor[],
    essentialKeys: string[],
  ) {
    super(qdrant, reranker, payloadSignals, essentialKeys);
  }

  async executeSearch(ctx: SearchContext): Promise<RawResult[]> {
    if (!ctx.embedding) {
      throw new Error(
        "VectorSearchStrategy requires an embedding in the context.",
      );
    }
    return this.qdrant.search(
      ctx.collectionName,
      ctx.embedding,
      ctx.limit,
      ctx.filter,
    );
  }
}
```

- [ ] **Step 2: Update VectorSearchStrategy tests**

Update test to pass new constructor args:

```typescript
import type { PayloadSignalDescriptor } from "../../../../src/core/contracts/types/trajectory.js";
import type { Reranker } from "../../../../src/core/explore/reranker.js";

const mockReranker = { rerank: vi.fn((r: any[]) => r) } as unknown as Reranker;
const SIGNALS: PayloadSignalDescriptor[] = [];
const KEYS: string[] = [];

// Replace: new VectorSearchStrategy(createMockQdrant())
// With:    new VectorSearchStrategy(createMockQdrant(), mockReranker, SIGNALS, KEYS)
```

Tests must verify `executeSearch` directly (for unit tests) and `execute` (for
integration with base class postProcess).

- [ ] **Step 3: Run tests**

Run: `npx vitest run tests/core/explore/strategies/vector.test.ts`

Expected: All PASS

- [ ] **Step 4: Commit**

```bash
git add src/core/explore/strategies/vector.ts tests/core/explore/strategies/vector.test.ts
git commit -m "refactor(explore): VectorSearchStrategy extends BaseSearchStrategy"
```

---

### Task 4: Migrate HybridSearchStrategy to extend BaseSearchStrategy

**Files:**

- Modify: `src/core/explore/strategies/hybrid.ts`
- Modify: `tests/core/explore/strategies/hybrid.test.ts`

- [ ] **Step 1: Update HybridSearchStrategy**

Same pattern as vector — extend `BaseSearchStrategy`, move `execute` ->
`executeSearch`. Constructor gains `reranker`, `payloadSignals`,
`essentialKeys`.

- [ ] **Step 2: Update tests with new constructor args**

- [ ] **Step 3: Run tests**

Run: `npx vitest run tests/core/explore/strategies/hybrid.test.ts`

Expected: All PASS

- [ ] **Step 4: Commit**

```bash
git add src/core/explore/strategies/hybrid.ts tests/core/explore/strategies/hybrid.test.ts
git commit -m "refactor(explore): HybridSearchStrategy extends BaseSearchStrategy"
```

---

### Task 5: Migrate ScrollRankStrategy to extend BaseSearchStrategy

**Files:**

- Modify: `src/core/explore/strategies/scroll-rank.ts`
- Modify: `tests/core/explore/strategies/scroll-rank.test.ts`

- [ ] **Step 1: Update ScrollRankStrategy — override applyDefaults**

Key differences from base:

- `applyDefaults`: metaOnly defaults to `true` (unless explicitly false), adds
  offset to fetchLimit, applies `excludeDocumentation` to filter
- `postProcess` override: handles offset slicing (skip first N), then calls
  super.postProcess for glob/rerank/trim/metaOnly

```typescript
export class ScrollRankStrategy extends BaseSearchStrategy {
  readonly type = "scroll-rank" as const;
  private readonly rankModule: RankModule;

  constructor(
    qdrant: QdrantManager,
    reranker: Reranker,
    payloadSignals: PayloadSignalDescriptor[],
    essentialKeys: string[],
  ) {
    super(qdrant, reranker, payloadSignals, essentialKeys);
    this.rankModule = new RankModule(reranker, reranker.getDescriptors());
  }

  protected applyDefaults(ctx: SearchContext): SearchContext {
    const metaOnly = ctx.metaOnly !== false; // defaults to true
    const effectiveOffset = ctx.offset || 0;
    const requestedLimit = ctx.limit || 10;
    const fetchLimit = requestedLimit + effectiveOffset;
    const effectiveFilter = excludeDocumentation(ctx.filter);

    // Resolve preset → weights (Reranker is Information Expert)
    let weights = ctx.weights;
    let presetName = ctx.presetName;
    if (!weights && ctx.rerank) {
      if (typeof ctx.rerank === "string") {
        const preset = this.reranker.getPreset(ctx.rerank, "rank_chunks");
        if (!preset)
          throw new Error(`Unknown preset "${ctx.rerank}" for rank_chunks.`);
        weights = Object.fromEntries(
          Object.entries(preset).filter(
            (e): e is [string, number] => typeof e[1] === "number",
          ),
        );
        presetName = ctx.rerank;
      } else if (typeof ctx.rerank === "object" && "custom" in ctx.rerank) {
        weights = (ctx.rerank as { custom: Record<string, number> }).custom;
      }
    }

    return {
      ...ctx,
      limit: fetchLimit,
      filter: effectiveFilter,
      metaOnly,
      offset: effectiveOffset,
      weights,
      presetName,
    };
  }

  async executeSearch(ctx: SearchContext): Promise<RawResult[]> {
    // ... existing logic (scrollFn, ensureIndexFn, rankModule.rankChunks)
    // weights are now guaranteed resolved by applyDefaults
  }

  protected postProcess(
    results: RawResult[],
    originalCtx: SearchContext,
  ): RawResult[] {
    let processed = results;

    // Apply pathPattern client-side
    if (originalCtx.pathPattern) {
      processed = filterResultsByGlob(processed, originalCtx.pathPattern);
    }

    // Apply offset
    const effectiveOffset = originalCtx.offset || 0;
    if (effectiveOffset > 0) {
      processed = processed.slice(effectiveOffset);
    }

    // Trim to requested limit
    const requestedLimit = originalCtx.limit || 10;
    processed = processed.slice(0, requestedLimit);

    // Apply metaOnly
    const metaOnly = originalCtx.metaOnly !== false;
    if (metaOnly) {
      return this.applyMetaOnly(processed);
    }

    return processed;
  }
}
```

- [ ] **Step 2: Update tests with new constructor args**

- [ ] **Step 3: Run tests**

Run: `npx vitest run tests/core/explore/strategies/scroll-rank.test.ts`

Expected: All PASS

- [ ] **Step 4: Commit**

```bash
git add src/core/explore/strategies/scroll-rank.ts tests/core/explore/strategies/scroll-rank.test.ts
git commit -m "refactor(explore): ScrollRankStrategy extends BaseSearchStrategy with own defaults"
```

---

### Task 6: Update factory to pass new dependencies

**Files:**

- Modify: `src/core/explore/strategies/factory.ts`
- Modify: `src/core/explore/strategies/index.ts` (barrel)
- Modify: `tests/core/explore/strategies/factory.test.ts`

- [ ] **Step 1: Update factory signature**

```typescript
import type { PayloadSignalDescriptor } from "../../contracts/types/trajectory.js";

export function createSearchStrategy(
  type: SearchStrategyType,
  qdrant: QdrantManager,
  reranker: Reranker,
  payloadSignals: PayloadSignalDescriptor[],
  essentialKeys: string[],
): BaseSearchStrategy {
  switch (type) {
    case "vector":
      return new VectorSearchStrategy(
        qdrant,
        reranker,
        payloadSignals,
        essentialKeys,
      );
    case "hybrid":
      return new HybridSearchStrategy(
        qdrant,
        reranker,
        payloadSignals,
        essentialKeys,
      );
    case "scroll-rank":
      return new ScrollRankStrategy(
        qdrant,
        reranker,
        payloadSignals,
        essentialKeys,
      );
    default:
      throw new Error(`Unknown search strategy type: ${type as string}`);
  }
}
```

- [ ] **Step 2: Update barrel to export BaseSearchStrategy**

```typescript
export { BaseSearchStrategy } from "./types.js";
```

- [ ] **Step 3: Update factory tests**

- [ ] **Step 4: Run all strategy tests**

Run: `npx vitest run tests/core/explore/strategies/`

Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/explore/strategies/ tests/core/explore/strategies/
git commit -m "refactor(explore): update strategy factory with base class dependencies"
```

---

## Chunk 2: Facade Rewrite

### Task 7: Rewrite ExploreFacade with unified pipeline

**Files:**

- Modify: `src/core/api/explore-facade.ts`
- Modify: `tests/core/api/explore-facade-expanded.test.ts`

- [ ] **Step 1: Write failing test for new facade**

Update `explore-facade-expanded.test.ts` — remove mocks for `ExploreModule`,
`post-process`, `RankModule`, `BM25SparseVectorGenerator`. The facade no longer
calls these directly — strategies handle them.

New test structure (key behaviors only):

```typescript
describe("ExploreFacade — unified pipeline", () => {
  // semanticSearch: resolve → validate → ensureStats → strategy → drift
  // hybridSearch: same pipeline, different strategy
  // rankChunks: same pipeline, scroll-rank strategy
  // searchCodeTyped: same pipeline with filter building + CodeSearchResult mapping
  // All: metaOnly handled by strategy, not facade
});
```

Tests should verify:

- `resolveCollection` still works (collection name or path)
- `validateCollectionExists` throws on missing collection
- `ensureStats` loads from cache on cold start
- drift warning passed through
- Strategies receive correct `SearchContext`

Remove tests that verify internal post-process/metaOnly calls (now strategy
responsibility).

- [ ] **Step 2: Rewrite ExploreFacade**

New facade (~150 lines):

```typescript
import type { EmbeddingProvider } from "../adapters/embeddings/base.js";
import type { QdrantManager } from "../adapters/qdrant/client.js";
import type { Reranker } from "../explore/reranker.js";
import {
  createSearchStrategy,
  type BaseSearchStrategy,
  type RawResult,
  type SearchContext,
} from "../explore/strategies/index.js";
import type { SchemaDriftMonitor } from "../infra/schema-drift-monitor.js";
import type { StatsCache } from "../infra/stats-cache.js";
import { resolveCollectionName, validatePath } from "../ingest/collection.js";
import type { TrajectoryRegistry } from "../trajectory/index.js";
import type {
  HybridSearchRequest,
  RankChunksRequest,
  SearchCodeRequest,
  SearchCodeResponse,
  SearchCodeResult,
  SearchResponse,
  SearchResult,
  SemanticSearchRequest,
} from "./app.js";

// Errors (facade-specific)
class CollectionRefError extends Error {
  /* ... */
}
class CollectionNotFoundError extends Error {
  /* ... */
}

export class ExploreFacade {
  private readonly vectorStrategy: BaseSearchStrategy;
  private readonly hybridStrategy: BaseSearchStrategy;
  private readonly scrollRankStrategy: BaseSearchStrategy;

  constructor(
    private readonly qdrant: QdrantManager,
    private readonly embeddings: EmbeddingProvider,
    private readonly reranker: Reranker,
    private readonly registry?: TrajectoryRegistry,
    private readonly statsCache?: StatsCache,
    private readonly schemaDriftMonitor?: SchemaDriftMonitor,
  ) {
    const payloadSignals = registry?.getAllPayloadSignalDescriptors() ?? [];
    const essentialKeys = registry?.getEssentialPayloadKeys() ?? [];
    this.vectorStrategy = createSearchStrategy(
      "vector",
      qdrant,
      reranker,
      payloadSignals,
      essentialKeys,
    );
    this.hybridStrategy = createSearchStrategy(
      "hybrid",
      qdrant,
      reranker,
      payloadSignals,
      essentialKeys,
    );
    this.scrollRankStrategy = createSearchStrategy(
      "scroll-rank",
      qdrant,
      reranker,
      payloadSignals,
      essentialKeys,
    );
  }

  async semanticSearch(
    request: SemanticSearchRequest,
  ): Promise<SearchResponse> {
    return this.executeExplore(request, this.vectorStrategy, async () => {
      const { embedding } = await this.embeddings.embed(request.query);
      return { embedding, rerank: request.rerank, metaOnly: request.metaOnly };
    });
  }

  async hybridSearch(request: HybridSearchRequest): Promise<SearchResponse> {
    return this.executeExplore(request, this.hybridStrategy, async () => {
      const { embedding } = await this.embeddings.embed(request.query);
      return {
        embedding,
        query: request.query,
        rerank: request.rerank,
        metaOnly: request.metaOnly,
      };
    });
  }

  async rankChunks(request: RankChunksRequest): Promise<SearchResponse> {
    // Weights resolution happens inside ScrollRankStrategy.applyDefaults()
    // which calls this.reranker.getPreset(). Facade only passes the rerank mode.
    return this.executeExplore(request, this.scrollRankStrategy, async () => ({
      level: request.level,
      offset: request.offset,
      metaOnly: request.metaOnly,
      rerank: request.rerank,
    }));
  }

  async searchCodeTyped(
    request: SearchCodeRequest,
  ): Promise<SearchCodeResponse> {
    // Resolve collection from path
    const absolutePath = await validatePath(request.path);
    const collectionName = resolveCollectionName(absolutePath);
    await this.validateCollectionExists(collectionName, request.path);
    await this.ensureStats(collectionName);

    // Build trajectory filters
    const filter = this.registry?.buildFilter({ ...request }, "chunk") as
      | Record<string, unknown>
      | undefined;

    // Choose strategy based on collection capability
    const collectionInfo = await this.qdrant.getCollectionInfo(collectionName);
    const strategy = collectionInfo.hybridEnabled
      ? this.hybridStrategy
      : this.vectorStrategy;

    const { embedding } = await this.embeddings.embed(request.query);
    const ctx: SearchContext = {
      collectionName,
      query: request.query,
      embedding,
      limit: request.limit || 5,
      filter,
      pathPattern: request.pathPattern,
      rerank: request.rerank,
    };

    const results = await strategy.execute(ctx);
    const codeResults = this.toCodeSearchResults(results);
    const driftWarning = this.schemaDriftMonitor
      ? await this.schemaDriftMonitor.checkAndConsume(request.path)
      : null;

    return { results: codeResults, driftWarning };
  }

  // -- Unified pipeline --

  private async executeExplore(
    request: {
      collection?: string;
      path?: string;
      limit?: number;
      filter?: Record<string, unknown>;
      pathPattern?: string;
    },
    strategy: BaseSearchStrategy,
    buildContext: () => Promise<Partial<SearchContext>>,
  ): Promise<SearchResponse> {
    const { collectionName, path } = this.resolveCollection(
      request.collection,
      request.path,
    );
    await this.validateCollectionExists(collectionName, path);
    await this.ensureStats(collectionName);

    const extra = await buildContext();
    const ctx: SearchContext = {
      collectionName,
      limit: request.limit || 5,
      filter: request.filter,
      pathPattern: request.pathPattern,
      ...extra,
    };

    const results = await strategy.execute(ctx);
    const searchResults = this.toSearchResults(results);
    const driftWarning = await this.checkDrift(path, collectionName);

    return { results: searchResults, driftWarning };
  }

  // -- Private helpers --
  // resolveCollection, validateCollectionExists, ensureStats, loadStatsFromCache,
  // checkDrift, toSearchResults: same as current facade
  // MINUS: metaOnly/postProcess (moved to strategy)
  // PLUS: toCodeSearchResults (maps RawResult[] to SearchCodeResult[])

  private toCodeSearchResults(results: RawResult[]): SearchCodeResult[] {
    return results.map((r) => {
      const p = r.payload ?? {};
      return {
        content: typeof p.content === "string" ? p.content : "",
        filePath: typeof p.relativePath === "string" ? p.relativePath : "",
        startLine: typeof p.startLine === "number" ? p.startLine : 0,
        endLine: typeof p.endLine === "number" ? p.endLine : 0,
        language: typeof p.language === "string" ? p.language : "unknown",
        score: r.score,
        fileExtension:
          typeof p.fileExtension === "string" ? p.fileExtension : "",
        metadata:
          p.git != null && typeof p.git === "object"
            ? ({ git: p.git } as Record<string, unknown>)
            : undefined,
      };
    });
  }
}
```

Note: constructor no longer takes `config: ExploreCodeConfig` or
`essentialTrajectoryFields`. It gets payload signals from registry.

- [ ] **Step 3: Run facade tests**

Run: `npx vitest run tests/core/api/explore-facade-expanded.test.ts`

Expected: All PASS

- [ ] **Step 4: Commit**

```bash
git add src/core/api/explore-facade.ts tests/core/api/explore-facade-expanded.test.ts
git commit -m "refactor(api): rewrite ExploreFacade with unified executeExplore pipeline"
```

---

### Task 8: Update explore-facade.test.ts (searchCode stats tests)

**Files:**

- Modify: `tests/core/api/explore-facade.test.ts`

- [ ] **Step 1: Update tests to remove ExploreModule mock**

The `searchCode` method no longer exists. Tests need to use `searchCodeTyped`
instead. Remove `vi.mock("explore-module.js")`. Update `makeExploreFacade` to
use new constructor signature (no `config` param, pass `registry` instead).

Stats loading tests (cold start, cache miss, etc.) remain — they test
`ensureStats` which is still in the facade.

- [ ] **Step 2: Run tests**

Run: `npx vitest run tests/core/api/explore-facade.test.ts`

Expected: All PASS

- [ ] **Step 3: Commit**

```bash
git add tests/core/api/explore-facade.test.ts
git commit -m "test(api): update ExploreFacade tests for new constructor and searchCodeTyped"
```

---

### Task 9: Update bootstrap factory

**Files:**

- Modify: `src/bootstrap/factory.ts`
- Modify: `src/bootstrap/config/index.ts`

- [ ] **Step 1: Update ExploreFacade construction in factory.ts**

Remove `config.exploreCode` argument, `essentialTrajectoryFields` argument. New
constructor:
`ExploreFacade(qdrant, embeddings, reranker, registry, statsCache, schemaDriftMonitor)`.

```typescript
const explore = new ExploreFacade(
  qdrant,
  embeddings,
  reranker,
  registry,
  statsCache,
  schemaDriftMonitor,
);
```

Remove the `essentialTrajectoryFields` variable.

- [ ] **Step 2: Remove `exploreCode` from AppConfig**

In `src/bootstrap/config/index.ts`, remove `exploreCode: ExploreCodeConfig` from
`AppConfig` and the corresponding initialization in `createAppConfig`.

- [ ] **Step 3: Run type-check**

Run: `npx tsc --noEmit`

Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/bootstrap/factory.ts src/bootstrap/config/index.ts
git commit -m "refactor(bootstrap): simplify ExploreFacade construction, remove ExploreCodeConfig"
```

---

## Chunk 3: Cleanup

### Task 10: Migrate integration tests (BEFORE deleting ExploreModule)

**Files:**

- Modify: `tests/core/explore/explore-module.test.ts` — rewrite to use
  `ExploreFacade.searchCodeTyped` instead of `searchCode`
- Modify: `tests/core/ingest/indexer.test.ts` — update `ExploreFacade`
  constructor (remove `defaultExploreConfig()`)
- Modify: `tests/core/ingest/__helpers__/test-helpers.ts` — remove
  `defaultExploreConfig` helper

The integration test at `tests/core/explore/explore-module.test.ts` (446 lines)
covers critical behavior: trajectory filter building (author, date range,
commitCount, taskId, documentationOnly), hybrid selection, result formatting,
pathPattern glob, rerank, git metadata in results, missing payload handling.

**This coverage MUST be preserved.** Migrate tests to use `searchCodeTyped`.

- [ ] **Step 1: Update ExploreFacade construction in integration test**

Replace:

```typescript
explore = new ExploreFacade(
  qdrant as any,
  embeddings,
  defaultExploreConfig(),
  reranker,
  registry,
);
```

With new constructor (no config):

```typescript
explore = new ExploreFacade(qdrant as any, embeddings, reranker, registry);
```

- [ ] **Step 2: Replace `searchCode` calls with `searchCodeTyped`**

Replace all `explore.searchCode(codebaseDir, query, options)` calls with:

```typescript
const response = await explore.searchCodeTyped({
  path: codebaseDir,
  query,
  ...options,
});
const results = response.results;
```

Adjust assertions to match `SearchCodeResult` shape (same fields as
`CodeSearchResult` — content, filePath, startLine, endLine, language, score,
fileExtension, metadata).

Note: `scoreThreshold` and `useHybrid` options are intentionally dropped — they
were `ExploreModule`-specific. `scoreThreshold` can be added later as a
`SearchCodeRequest` field if needed. `useHybrid` is replaced by automatic
collection capability detection.

- [ ] **Step 3: Update `tests/core/ingest/indexer.test.ts`**

Line 76 uses old constructor. Update to new signature:

```typescript
explore = new ExploreFacade(qdrant as any, embeddings, reranker, registry);
```

Remove `defaultExploreConfig` import.

- [ ] **Step 4: Remove `defaultExploreConfig` from test helpers**

Delete the `defaultExploreConfig()` function from
`tests/core/ingest/__helpers__/test-helpers.ts` and its export.

- [ ] **Step 5: Run integration tests**

Run:
`npx vitest run tests/core/explore/explore-module.test.ts tests/core/ingest/indexer.test.ts`

Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add tests/core/explore/explore-module.test.ts tests/core/ingest/indexer.test.ts tests/core/ingest/__helpers__/test-helpers.ts
git commit -m "test(explore): migrate integration tests to searchCodeTyped and new constructor"
```

---

### Task 11: Delete ExploreModule and legacy types

**Files:**

- Delete: `src/core/explore/explore-module.ts`
- Modify: `src/core/types.ts` — remove `SearchOptions`, `ExploreCodeConfig`

- [ ] **Step 1: Delete ExploreModule**

```bash
rm src/core/explore/explore-module.ts
```

Note: `FilterBuilder` type exported from this file is orphaned — no other
consumer exists. It is deleted with the file.

- [ ] **Step 2: Remove SearchOptions and ExploreCodeConfig from types.ts**

Delete the `SearchOptions` interface (lines 156-182) and `ExploreCodeConfig`
interface (lines 28-31) from `src/core/types.ts`.

- [ ] **Step 3: Run type-check and tests**

Run: `npx tsc --noEmit && npx vitest run`

Expected: No type errors, all tests pass. If any imports break, fix them.

- [ ] **Step 4: Commit**

```bash
git add -u
git commit -m "refactor(explore): delete ExploreModule and legacy SearchOptions/ExploreCodeConfig"
```

---

### Task 12: Remove duplicate errors, helpers, and dead code

**Files:**

- Modify: `src/core/api/explore-facade.ts` — remove `HybridNotEnabledError`,
  `excludeDocumentation` if still present
- Modify: `src/core/explore/post-process.ts` — remove orphaned
  `computeFetchLimit` and `postProcess` (now in `BaseSearchStrategy`)

- [ ] **Step 1: Verify facade no longer references duplicates**

After Task 7 rewrite, the facade should not import or define
`HybridNotEnabledError` or `excludeDocumentation`. Remove if present. Canonical
locations:

- `HybridNotEnabledError` → `explore/strategies/types.ts`
- `excludeDocumentation` → `explore/strategies/scroll-rank.ts`

Also remove unused imports from facade: `BM25SparseVectorGenerator`,
`ExploreModule`, `scrollOrderedBy`, `RankModule`, `computeFetchLimit`,
`postProcess`, `BASE_PAYLOAD_SIGNALS`.

- [ ] **Step 2: Clean up orphaned functions in post-process.ts**

`computeFetchLimit` and `postProcess` functions are now absorbed into
`BaseSearchStrategy`. Verify no other file imports them. If not, delete them.
Keep: `filterMetaOnly` (used by `BaseSearchStrategy.applyMetaOnly`),
`SearchResult` type, `FetchLimits` type (if still referenced).

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run`

Expected: All PASS

- [ ] **Step 4: Commit**

```bash
git add src/core/api/explore-facade.ts src/core/explore/post-process.ts
git commit -m "refactor: remove duplicate errors, helpers, and orphaned post-process functions"
```

---

### Task 13: Update create-app.test.ts

**Files:**

- Modify: `tests/core/api/create-app.test.ts`

- [ ] **Step 1: Verify create-app tests still pass**

The `App` interface doesn't change, so `createApp` tests should be unaffected.
But `createMockExploreFacade` may need updating if `ExploreFacade` method
signatures changed.

Run: `npx vitest run tests/core/api/create-app.test.ts`

If failures, update mocks.

- [ ] **Step 2: Commit if changes needed**

```bash
git add tests/core/api/create-app.test.ts
git commit -m "test(api): update createApp tests for new ExploreFacade"
```

---

### Task 14: Final verification and CLAUDE.md update

**Files:**

- Modify: `.claude/CLAUDE.md` — update project structure tree

- [ ] **Step 1: Run full test suite + type-check**

Run: `npx tsc --noEmit && npx vitest run`

Expected: All PASS, no type errors

- [ ] **Step 2: Verify line counts**

```bash
wc -l src/core/api/explore-facade.ts
# Expected: ~150 lines (down from 403)

ls src/core/explore/explore-module.ts 2>/dev/null
# Expected: file does not exist
```

- [ ] **Step 3: Update CLAUDE.md project structure**

In `.claude/CLAUDE.md`, update the `explore/` section to reflect:

- Remove `explore-module.ts`
- Add `strategies/types.ts` note about `BaseSearchStrategy`

Update `api/` section:

- Note simplified `ExploreFacade` constructor (no config, no
  essentialTrajectoryFields)

- [ ] **Step 4: Commit**

```bash
git add .claude/CLAUDE.md
git commit -m "docs: update CLAUDE.md project structure after GRASP refactoring"
```
