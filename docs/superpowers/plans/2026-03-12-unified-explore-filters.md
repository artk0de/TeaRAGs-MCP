# Unified Explore Filters & Type Consolidation — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development
> (if subagents available) or superpowers:executing-plans to implement this
> plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make all 4 search MCP tools use consistent typed filter params + raw
Qdrant filter, consolidate response/result types into single ExploreResult /
ExploreResponse, and delete legacy ExploreModule.

**Architecture:** FilterDescriptor gains `must_not` support via
`FilterConditionResult`. `TrajectoryRegistry.buildFilter()` collects both `must`
and `must_not`. ExploreFacade gains `buildMergedFilter()` that merges typed
params with raw filter. search_code migrates to strategy pipeline. MCP layer
owns presentation formatting.

**Tech Stack:** TypeScript, Vitest, Qdrant filter types, picomatch

**Spec:** `docs/superpowers/specs/2026-03-12-unified-explore-filters-design.md`

---

## Chunk 1: FilterDescriptor Extension, Filters & Registry Update

### Task 1: Extend FilterDescriptor, update all filters, update registry

This task is atomic — all three changes (type, filters, registry) must be in one
commit because the type change breaks compilation until filters and registry are
updated.

**Files:**

- Modify: `src/core/contracts/types/provider.ts`
- Modify: `src/core/trajectory/static/filters.ts`
- Modify: `src/core/trajectory/git/filters.ts`
- Modify: `src/core/trajectory/index.ts`
- Test: `tests/core/trajectory/registry-filter.test.ts` (create)
- Test: `tests/core/trajectory/static/filters.test.ts` (create)

- [ ] **Step 1: Add FilterConditionResult interface to provider.ts**

In `src/core/contracts/types/provider.ts`, add after the `FilterLevel` type:

```typescript
/** Result of converting a user param to Qdrant filter conditions. */
export interface FilterConditionResult {
  must?: QdrantFilterCondition[];
  must_not?: QdrantFilterCondition[];
}
```

- [ ] **Step 2: Update FilterDescriptor.toCondition return type**

Change `toCondition` signature from:

```typescript
toCondition: (value: unknown, level?: FilterLevel) => QdrantFilterCondition[];
```

to:

```typescript
toCondition: (value: unknown, level?: FilterLevel) => FilterConditionResult;
```

- [ ] **Step 3: Update static filters to return FilterConditionResult**

In `src/core/trajectory/static/filters.ts`, wrap each `toCondition` return in
`{ must: [...] }`:

```typescript
export const staticFilters: FilterDescriptor[] = [
  {
    param: "language",
    description: "Filter by programming language",
    type: "string",
    toCondition: (value: unknown) => ({
      must: [{ key: "language", match: { value: value as string } }],
    }),
  },
  {
    param: "fileExtension",
    description: "Filter by file extension (e.g. '.ts')",
    type: "string",
    toCondition: (value: unknown) => ({
      must: [{ key: "fileExtension", match: { value: value as string } }],
    }),
  },
  {
    param: "chunkType",
    description: "Filter by chunk type (function, class, interface, block)",
    type: "string",
    toCondition: (value: unknown) => ({
      must: [{ key: "chunkType", match: { value: value as string } }],
    }),
  },
  {
    param: "isDocumentation",
    description: "Filter documentation chunks",
    type: "boolean",
    toCondition: (value: unknown) => ({
      must: [{ key: "isDocumentation", match: { value: value as boolean } }],
    }),
  },
];
```

- [ ] **Step 4: Add excludeDocumentation FilterDescriptor**

Append to `staticFilters` array:

```typescript
{
  param: "excludeDocumentation",
  description: "Exclude documentation chunks from results",
  type: "boolean",
  toCondition: (value: unknown) => {
    if (!value) return {};
    return {
      must_not: [{ key: "isDocumentation", match: { value: true } }],
    };
  },
},
```

Note: when `value` is `false`, returns empty object `{}` — no conditions added.
This prevents `excludeDocumentation: false` from doing anything.

- [ ] **Step 5: Add fileTypes FilterDescriptor**

Append to `staticFilters` array. This uses `match: { any: [...] }` for
array-based file extension filtering (replaces ExploreModule's hardcoded logic):

```typescript
{
  param: "fileTypes",
  description: "Filter by file extensions array (e.g. ['.ts', '.py'])",
  type: "string[]",
  toCondition: (value: unknown) => {
    const arr = value as string[];
    if (!arr || arr.length === 0) return {};
    return {
      must: [{ key: "fileExtension", match: { any: arr } }],
    };
  },
},
```

- [ ] **Step 6: Add documentationOnly FilterDescriptor**

Append to `staticFilters` array. This maps `documentationOnly: true` →
`isDocumentation: true` (same as `isDocumentation` but with legacy param name):

```typescript
{
  param: "documentationOnly",
  description: "Search only in documentation files (markdown, READMEs)",
  type: "boolean",
  toCondition: (value: unknown) => {
    if (!value) return {};
    return {
      must: [{ key: "isDocumentation", match: { value: true } }],
    };
  },
},
```

- [ ] **Step 7: Update git filters to return FilterConditionResult**

In `src/core/trajectory/git/filters.ts`, wrap each `toCondition` return in
`{ must: [...] }`. Example for author:

```typescript
toCondition: (value: unknown) => ({
  must: [{ key: "git.file.dominantAuthor", match: { value: value as string } }],
}),
```

Apply the same pattern to all 7 git filters: `author`, `modifiedAfter`,
`modifiedBefore`, `minAgeDays`, `maxAgeDays`, `minCommitCount`, `taskId`.

- [ ] **Step 8: Update TrajectoryRegistry.buildFilter() for must + must_not**

In `src/core/trajectory/index.ts`, replace the `buildFilter` method body:

```typescript
buildFilter(params: Record<string, unknown>, level: FilterLevel = "chunk"): QdrantFilter | undefined {
  const allFilters = this.getAllFilters();
  const mustConditions: QdrantFilterCondition[] = [];
  const mustNotConditions: QdrantFilterCondition[] = [];

  for (const filter of allFilters) {
    const value = params[filter.param];
    if (value === undefined || value === null) continue;
    const result = filter.toCondition(value, level);
    if (result.must) mustConditions.push(...result.must);
    if (result.must_not) mustNotConditions.push(...result.must_not);
  }

  if (mustConditions.length === 0 && mustNotConditions.length === 0) return undefined;

  const filter: QdrantFilter = {};
  if (mustConditions.length > 0) filter.must = mustConditions;
  if (mustNotConditions.length > 0) filter.must_not = mustNotConditions;
  return filter;
}
```

- [ ] **Step 9: Write tests for static filters**

Create `tests/core/trajectory/static/filters.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import { staticFilters } from "../../../../src/core/trajectory/static/filters.js";

describe("staticFilters", () => {
  it("includes excludeDocumentation filter", () => {
    const filter = staticFilters.find(
      (f) => f.param === "excludeDocumentation",
    );
    expect(filter).toBeDefined();
    expect(filter!.type).toBe("boolean");
  });

  it("excludeDocumentation=true produces must_not condition", () => {
    const filter = staticFilters.find(
      (f) => f.param === "excludeDocumentation",
    )!;
    const result = filter.toCondition(true);
    expect(result.must_not).toEqual([
      { key: "isDocumentation", match: { value: true } },
    ]);
    expect(result.must).toBeUndefined();
  });

  it("excludeDocumentation=false produces no conditions", () => {
    const filter = staticFilters.find(
      (f) => f.param === "excludeDocumentation",
    )!;
    const result = filter.toCondition(false);
    expect(result.must).toBeUndefined();
    expect(result.must_not).toBeUndefined();
  });

  it("isDocumentation produces must condition", () => {
    const filter = staticFilters.find((f) => f.param === "isDocumentation")!;
    const result = filter.toCondition(true);
    expect(result.must).toEqual([
      { key: "isDocumentation", match: { value: true } },
    ]);
  });

  it("language produces must condition", () => {
    const filter = staticFilters.find((f) => f.param === "language")!;
    const result = filter.toCondition("typescript");
    expect(result.must).toEqual([
      { key: "language", match: { value: "typescript" } },
    ]);
  });

  it("fileTypes produces must condition with match.any", () => {
    const filter = staticFilters.find((f) => f.param === "fileTypes")!;
    const result = filter.toCondition([".ts", ".py"]);
    expect(result.must).toEqual([
      { key: "fileExtension", match: { any: [".ts", ".py"] } },
    ]);
  });

  it("fileTypes with empty array produces no conditions", () => {
    const filter = staticFilters.find((f) => f.param === "fileTypes")!;
    const result = filter.toCondition([]);
    expect(result.must).toBeUndefined();
  });

  it("documentationOnly=true produces must condition", () => {
    const filter = staticFilters.find((f) => f.param === "documentationOnly")!;
    const result = filter.toCondition(true);
    expect(result.must).toEqual([
      { key: "isDocumentation", match: { value: true } },
    ]);
  });

  it("documentationOnly=false produces no conditions", () => {
    const filter = staticFilters.find((f) => f.param === "documentationOnly")!;
    const result = filter.toCondition(false);
    expect(result.must).toBeUndefined();
  });
});
```

- [ ] **Step 10: Write tests for registry buildFilter**

Create `tests/core/trajectory/registry-filter.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import type { FilterDescriptor } from "../../../src/core/contracts/types/provider.js";
import type { Trajectory } from "../../../src/core/contracts/types/trajectory.js";
import { TrajectoryRegistry } from "../../../src/core/trajectory/index.js";

function makeTrajectory(filters: FilterDescriptor[]): Trajectory {
  return {
    key: "test",
    name: "Test Trajectory",
    description: "Test trajectory for filter tests",
    payloadSignals: [],
    derivedSignals: [],
    filters,
    presets: [],
  };
}

describe("TrajectoryRegistry.buildFilter — must + must_not", () => {
  it("collects must conditions from FilterConditionResult", () => {
    const registry = new TrajectoryRegistry();
    registry.register(
      makeTrajectory([
        {
          param: "language",
          description: "lang",
          type: "string",
          toCondition: (v) => ({
            must: [{ key: "language", match: { value: v as string } }],
          }),
        },
      ]),
    );
    const filter = registry.buildFilter({ language: "typescript" });
    expect(filter?.must).toEqual([
      { key: "language", match: { value: "typescript" } },
    ]);
  });

  it("collects must_not conditions from FilterConditionResult", () => {
    const registry = new TrajectoryRegistry();
    registry.register(
      makeTrajectory([
        {
          param: "excludeDocumentation",
          description: "exclude docs",
          type: "boolean",
          toCondition: () => ({
            must_not: [{ key: "isDocumentation", match: { value: true } }],
          }),
        },
      ]),
    );
    const filter = registry.buildFilter({ excludeDocumentation: true });
    expect(filter?.must_not).toEqual([
      { key: "isDocumentation", match: { value: true } },
    ]);
    expect(filter?.must).toBeUndefined();
  });

  it("merges must and must_not from different filters", () => {
    const registry = new TrajectoryRegistry();
    registry.register(
      makeTrajectory([
        {
          param: "language",
          description: "lang",
          type: "string",
          toCondition: (v) => ({
            must: [{ key: "language", match: { value: v as string } }],
          }),
        },
        {
          param: "excludeDocumentation",
          description: "exclude docs",
          type: "boolean",
          toCondition: () => ({
            must_not: [{ key: "isDocumentation", match: { value: true } }],
          }),
        },
      ]),
    );
    const filter = registry.buildFilter({
      language: "typescript",
      excludeDocumentation: true,
    });
    expect(filter?.must).toHaveLength(1);
    expect(filter?.must_not).toHaveLength(1);
  });

  it("returns undefined when no params match", () => {
    const registry = new TrajectoryRegistry();
    registry.register(makeTrajectory([]));
    expect(registry.buildFilter({})).toBeUndefined();
  });
});
```

- [ ] **Step 11: Run type-check and tests**

Run: `npx tsc --noEmit && npx vitest run`

Expected: PASS

- [ ] **Step 12: Commit**

```bash
git add src/core/contracts/types/provider.ts src/core/trajectory/static/filters.ts src/core/trajectory/git/filters.ts src/core/trajectory/index.ts tests/core/trajectory/
git commit -m "refactor(filters): extend FilterDescriptor for must_not, add fileTypes/excludeDocumentation/documentationOnly descriptors"
```

---

## Chunk 2: Type Consolidation

### Task 2: Rename types — ExploreResponse, ExploreCodeRequest

**Files:**

- Modify: `src/core/contracts/types/app.ts`
- Modify: `src/core/api/app.ts`
- Modify: `src/core/api/explore-facade.ts`

- [ ] **Step 1: Rename in contracts/types/app.ts**

1. Rename `SearchCodeRequest` → `ExploreCodeRequest`
2. Rename `SearchResponse` → `ExploreResponse`
3. Add backward compat aliases (temporary, removed in Task 8):

```typescript
/** @deprecated Use ExploreCodeRequest */
export type SearchCodeRequest = ExploreCodeRequest;
/** @deprecated Use ExploreResponse */
export type SearchResponse = ExploreResponse;
/** @deprecated Use ExploreResponse */
export type SearchCodeResponse = ExploreResponse;
```

- [ ] **Step 2: Update explore-facade.ts return types**

Replace `SearchResponse` with `ExploreResponse` in:

- `semanticSearch` return type
- `hybridSearch` return type
- `rankChunks` return type
- `searchCodeTyped` return type
- `executeExplore` private method return type

Also remove `toSearchResults()` — instead return `ExploreResult[]` directly from
`executeExplore`. The `toSearchResults()` method coerced `ExploreResult.id`
(optional) to `SearchResult.id` (required, defaulting to `""`). Since
`ExploreResponse.results` uses `SearchResult[]` which still exists via alias,
and we're moving to `ExploreResult` directly, update `executeExplore` to return
results without coercion:

```typescript
private async executeExplore(
  strategy: BaseExploreStrategy,
  ctx: ExploreContext,
  path?: string,
): Promise<ExploreResponse> {
  await this.validateCollectionExists(ctx.collectionName, path);
  await this.ensureStats(ctx.collectionName);
  const results = await strategy.execute(ctx);
  const driftWarning = await this.checkDrift(path, ctx.collectionName);
  return { results: results as SearchResult[], driftWarning };
}
```

Note: `results as SearchResult[]` is safe because `ExploreResult` is
structurally compatible (id is optional → compatible with required via cast).
This cast will be removed when `SearchResult` alias is removed in Task 8.

- [ ] **Step 3: Update re-exports in app.ts**

Add `ExploreResponse` and `ExploreCodeRequest` to the re-export list.

- [ ] **Step 4: Run type-check**

Run: `npx tsc --noEmit`

Expected: PASS (aliases preserve backward compat)

- [ ] **Step 5: Commit**

```bash
git add src/core/contracts/types/app.ts src/core/api/explore-facade.ts src/core/api/app.ts
git commit -m "refactor(contracts): rename SearchResponse → ExploreResponse, SearchCodeRequest → ExploreCodeRequest"
```

---

## Chunk 3: Facade — buildMergedFilter & exploreCode

### Task 3: Add buildMergedFilter() to ExploreFacade

**Files:**

- Modify: `src/core/api/explore-facade.ts`
- Modify: `src/core/contracts/types/app.ts`
- Test: `tests/core/api/explore-facade-filter.test.ts` (create)

- [ ] **Step 1: Add TypedFilterParams to request DTOs**

In `src/core/contracts/types/app.ts`, add interface and extend requests:

```typescript
/** Typed filter params shared across all search requests. */
export interface TypedFilterParams {
  // Static trajectory filters
  language?: string;
  fileExtension?: string;
  chunkType?: string;
  isDocumentation?: boolean;
  excludeDocumentation?: boolean;
  fileTypes?: string[];
  documentationOnly?: boolean;
  // Git trajectory filters
  author?: string;
  modifiedAfter?: string | Date;
  modifiedBefore?: string | Date;
  minAgeDays?: number;
  maxAgeDays?: number;
  minCommitCount?: number;
  taskId?: string;
}
```

Add `extends TypedFilterParams` to `SemanticSearchRequest`,
`HybridSearchRequest`, `RankChunksRequest`, and `ExploreCodeRequest`.

- [ ] **Step 2: Implement buildMergedFilter() in ExploreFacade**

In `src/core/api/explore-facade.ts`, add private method:

```typescript
/**
 * Merge typed filter params (via registry) with raw Qdrant filter.
 * Typed must/must_not are appended to raw filter's arrays.
 * Raw filter's should is preserved untouched.
 */
private buildMergedFilter(
  typedParams: Record<string, unknown>,
  rawFilter?: Record<string, unknown>,
  level: "chunk" | "file" = "chunk",
): Record<string, unknown> | undefined {
  const typedFilter = this.registry?.buildFilter(typedParams, level);
  if (!typedFilter && !rawFilter) return undefined;
  if (!typedFilter) return rawFilter;
  if (!rawFilter) return typedFilter as Record<string, unknown>;

  const merged: Record<string, unknown> = { ...rawFilter };
  const rawMust = Array.isArray(rawFilter.must) ? rawFilter.must : [];
  const typedMust = Array.isArray(typedFilter.must) ? typedFilter.must : [];
  if (rawMust.length > 0 || typedMust.length > 0) {
    merged.must = [...rawMust, ...typedMust];
  }

  const rawMustNot = Array.isArray(rawFilter.must_not) ? rawFilter.must_not : [];
  const typedMustNot = Array.isArray(typedFilter.must_not) ? typedFilter.must_not : [];
  if (rawMustNot.length > 0 || typedMustNot.length > 0) {
    merged.must_not = [...rawMustNot, ...typedMustNot];
  }

  return merged;
}
```

- [ ] **Step 3: Update semanticSearch, hybridSearch, rankChunks to use
      buildMergedFilter**

In each method, extract typed params from request and merge with raw filter:

```typescript
async semanticSearch(request: SemanticSearchRequest): Promise<ExploreResponse> {
  const { collectionName, path } = this.resolveCollection(request.collection, request.path);
  const { embedding } = await this.embeddings.embed(request.query);
  const filter = this.buildMergedFilter(request, request.filter);
  return this.executeExplore(
    this.vectorStrategy,
    {
      collectionName,
      query: request.query,
      embedding,
      limit: request.limit ?? 10,
      filter,
      pathPattern: request.pathPattern,
      rerank: request.rerank,
      metaOnly: request.metaOnly,
    },
    path,
  );
}
```

Apply same pattern to `hybridSearch` and `rankChunks`.

- [ ] **Step 4: Write test for buildMergedFilter behavior**

Create `tests/core/api/explore-facade-filter.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";

import { ExploreFacade } from "../../../src/core/api/explore-facade.js";

function createMockQdrant() {
  return {
    collectionExists: vi.fn().mockResolvedValue(true),
    getCollectionInfo: vi.fn().mockResolvedValue({ hybridEnabled: false }),
    search: vi.fn().mockResolvedValue([]),
    hybridSearch: vi.fn().mockResolvedValue([]),
    ensurePayloadIndex: vi.fn(),
  } as any;
}

function createMockEmbeddings() {
  return {
    embed: vi.fn().mockResolvedValue({ embedding: [0.1, 0.2, 0.3] }),
  } as any;
}

function createMockReranker() {
  return {
    rerank: vi.fn((results: any[]) => results),
    hasCollectionStats: false,
    setCollectionStats: vi.fn(),
    getDescriptors: vi.fn().mockReturnValue([]),
    getPreset: vi.fn(),
    getPresetNames: vi.fn().mockReturnValue([]),
    getDescriptorInfo: vi.fn().mockReturnValue([]),
  } as any;
}

function createMockRegistry() {
  return {
    buildFilter: vi.fn().mockReturnValue(undefined),
    getAllFilters: vi.fn().mockReturnValue([]),
    getAllPayloadSignalDescriptors: vi.fn().mockReturnValue([]),
    getEssentialPayloadKeys: vi.fn().mockReturnValue([]),
  } as any;
}

function makeFacade(
  overrides: {
    qdrant?: any;
    registry?: any;
  } = {},
) {
  const qdrant = overrides.qdrant ?? createMockQdrant();
  return new ExploreFacade(
    qdrant,
    createMockEmbeddings(),
    { enableHybridSearch: false, defaultSearchLimit: 5 },
    createMockReranker(),
    overrides.registry ?? createMockRegistry(),
    undefined,
    [],
    [],
    undefined,
  );
}

describe("ExploreFacade.buildMergedFilter", () => {
  it("passes typed params to registry.buildFilter", async () => {
    const registry = createMockRegistry();
    registry.buildFilter.mockReturnValue({
      must: [{ key: "language", match: { value: "typescript" } }],
    });
    const qdrant = createMockQdrant();
    const facade = makeFacade({ qdrant, registry });

    await facade.semanticSearch({
      collection: "test",
      query: "test query",
      language: "typescript",
    });

    expect(registry.buildFilter).toHaveBeenCalledWith(
      expect.objectContaining({ language: "typescript" }),
      "chunk",
    );
    expect(qdrant.search).toHaveBeenCalledWith(
      "test",
      expect.any(Array),
      expect.any(Number),
      expect.objectContaining({
        must: [{ key: "language", match: { value: "typescript" } }],
      }),
    );
  });

  it("merges typed filter with raw filter", async () => {
    const registry = createMockRegistry();
    registry.buildFilter.mockReturnValue({
      must: [{ key: "language", match: { value: "typescript" } }],
    });
    const qdrant = createMockQdrant();
    const facade = makeFacade({ qdrant, registry });

    await facade.semanticSearch({
      collection: "test",
      query: "test query",
      language: "typescript",
      filter: {
        must: [{ key: "relativePath", match: { text: "src/" } }],
      },
    });

    const filterArg = qdrant.search.mock.calls[0][3] as Record<string, unknown>;
    const must = filterArg.must as unknown[];
    expect(must).toHaveLength(2);
  });

  it("preserves raw filter's must_not and should", async () => {
    const registry = createMockRegistry();
    registry.buildFilter.mockReturnValue({
      must_not: [{ key: "isDocumentation", match: { value: true } }],
    });
    const qdrant = createMockQdrant();
    const facade = makeFacade({ qdrant, registry });

    await facade.semanticSearch({
      collection: "test",
      query: "test query",
      excludeDocumentation: true,
      filter: {
        should: [{ key: "chunkType", match: { value: "function" } }],
      },
    });

    const filterArg = qdrant.search.mock.calls[0][3] as Record<string, unknown>;
    expect(filterArg.must_not).toEqual([
      { key: "isDocumentation", match: { value: true } },
    ]);
    expect(filterArg.should).toEqual([
      { key: "chunkType", match: { value: "function" } },
    ]);
  });
});
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/core/api/explore-facade-filter.test.ts`

Expected: PASS

- [ ] **Step 6: Run all tests**

Run: `npx vitest run`

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/core/contracts/types/app.ts src/core/api/explore-facade.ts tests/core/api/explore-facade-filter.test.ts
git commit -m "feat(explore): add buildMergedFilter for typed filter params across all search tools"
```

---

### Task 4: Migrate search_code to strategy pipeline (exploreCode)

**Files:**

- Modify: `src/core/api/explore-facade.ts`
- Modify: `src/core/api/app.ts`
- Modify: `src/core/api/create-app.ts`
- Test: `tests/core/api/explore-facade-explore-code.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/core/api/explore-facade-explore-code.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";

import { ExploreFacade } from "../../../src/core/api/explore-facade.js";

function createMockQdrant() {
  return {
    collectionExists: vi.fn().mockResolvedValue(true),
    getCollectionInfo: vi.fn().mockResolvedValue({ hybridEnabled: false }),
    search: vi.fn().mockResolvedValue([
      {
        id: "1",
        score: 0.9,
        payload: {
          content: "function hello() {}",
          relativePath: "src/hello.ts",
          startLine: 1,
          endLine: 3,
          language: "typescript",
          fileExtension: ".ts",
        },
      },
    ]),
    hybridSearch: vi.fn().mockResolvedValue([]),
    ensurePayloadIndex: vi.fn(),
  } as any;
}

function createMockEmbeddings() {
  return {
    embed: vi.fn().mockResolvedValue({ embedding: [0.1, 0.2] }),
  } as any;
}

function createMockReranker() {
  return {
    rerank: vi.fn((results: any[]) => results),
    hasCollectionStats: false,
    setCollectionStats: vi.fn(),
    getDescriptors: vi.fn().mockReturnValue([]),
    getPreset: vi.fn(),
    getPresetNames: vi.fn().mockReturnValue([]),
    getDescriptorInfo: vi.fn().mockReturnValue([]),
  } as any;
}

function createMockRegistry() {
  return {
    buildFilter: vi.fn().mockReturnValue(undefined),
    getAllFilters: vi.fn().mockReturnValue([]),
  } as any;
}

function makeFacade(overrides: { qdrant?: any; registry?: any } = {}) {
  return new ExploreFacade(
    overrides.qdrant ?? createMockQdrant(),
    createMockEmbeddings(),
    { enableHybridSearch: false, defaultSearchLimit: 5 },
    createMockReranker(),
    overrides.registry ?? createMockRegistry(),
    undefined,
    [],
    [],
    undefined,
  );
}

describe("ExploreFacade.exploreCode", () => {
  it("returns ExploreResponse with payload containing content", async () => {
    const facade = makeFacade();
    const response = await facade.exploreCode({
      path: "/test/project",
      query: "hello function",
    });

    expect(response.results).toHaveLength(1);
    expect(response.results[0].score).toBe(0.9);
    expect(response.results[0].payload?.relativePath).toBe("src/hello.ts");
    expect(response.results[0].payload?.content).toBe("function hello() {}");
    expect(response.driftWarning).toBeNull();
  });

  it("uses hybrid strategy when collection supports it", async () => {
    const qdrant = createMockQdrant();
    qdrant.getCollectionInfo.mockResolvedValue({ hybridEnabled: true });
    qdrant.hybridSearch.mockResolvedValue([
      { id: "1", score: 0.85, payload: { content: "x", relativePath: "a.ts" } },
    ]);

    const facade = makeFacade({ qdrant });
    const response = await facade.exploreCode({
      path: "/test/project",
      query: "test",
    });

    expect(qdrant.hybridSearch).toHaveBeenCalled();
    expect(response.results).toHaveLength(1);
  });

  it("passes typed filter params through buildMergedFilter", async () => {
    const registry = createMockRegistry();
    registry.buildFilter.mockReturnValue({
      must: [{ key: "git.file.dominantAuthor", match: { value: "Alice" } }],
    });

    const facade = makeFacade({ registry });
    await facade.exploreCode({
      path: "/test/project",
      query: "auth logic",
      author: "Alice",
    });

    expect(registry.buildFilter).toHaveBeenCalledWith(
      expect.objectContaining({ author: "Alice" }),
      "chunk",
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/api/explore-facade-explore-code.test.ts`

Expected: FAIL — `exploreCode` doesn't exist.

- [ ] **Step 3: Implement exploreCode on ExploreFacade**

In `src/core/api/explore-facade.ts`, add method:

```typescript
/** search_code replacement — uses strategy pipeline with auto-detect hybrid. */
async exploreCode(request: ExploreCodeRequest): Promise<ExploreResponse> {
  const absolutePath = await validatePath(request.path);
  const collectionName = resolveCollectionName(absolutePath);
  const { embedding } = await this.embeddings.embed(request.query);
  const filter = this.buildMergedFilter(request, request.filter);

  // Auto-detect hybrid capability
  const collectionInfo = await this.qdrant.getCollectionInfo(collectionName);
  const strategy = collectionInfo.hybridEnabled ? this.hybridStrategy : this.vectorStrategy;

  return this.executeExplore(
    strategy,
    {
      collectionName,
      query: request.query,
      embedding,
      limit: request.limit ?? 10,
      filter,
      pathPattern: request.pathPattern,
      rerank: request.rerank,
    },
    request.path,
  );
}
```

- [ ] **Step 4: Update App interface and create-app.ts**

In `src/core/api/app.ts`, add to App interface:

```typescript
exploreCode: (request: ExploreCodeRequest) => Promise<ExploreResponse>;
```

In `src/core/api/create-app.ts`, add to the return object:

```typescript
exploreCode: async (req) => deps.explore.exploreCode(req),
```

Import `ExploreCodeRequest` and `ExploreResponse` from contracts.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/core/api/explore-facade-explore-code.test.ts`

Expected: PASS

- [ ] **Step 6: Run all tests**

Run: `npx vitest run`

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/core/api/explore-facade.ts src/core/api/app.ts src/core/api/create-app.ts tests/core/api/explore-facade-explore-code.test.ts
git commit -m "feat(explore): add exploreCode method with auto-detect hybrid and typed filters"
```

---

## Chunk 4: MCP Tool Updates & Schema Unification

### Task 5: Add typed filter params to MCP search tool schemas

**Files:**

- Modify: `src/mcp/tools/schemas.ts`

- [ ] **Step 1: Add typedFilterFields() helper**

In `src/mcp/tools/schemas.ts`, add:

```typescript
function typedFilterFields() {
  return {
    language: z.string().optional().describe("Filter by programming language"),
    fileExtension: z
      .string()
      .optional()
      .describe("Filter by file extension (e.g. '.ts')"),
    chunkType: z
      .string()
      .optional()
      .describe("Filter by chunk type (function, class, interface, block)"),
    isDocumentation: coerceBoolean()
      .optional()
      .describe("Include only documentation chunks"),
    excludeDocumentation: coerceBoolean()
      .optional()
      .describe("Exclude documentation chunks from results"),
    author: z
      .string()
      .optional()
      .describe("Filter by dominant author. Example: 'John Doe'"),
    modifiedAfter: z
      .string()
      .optional()
      .describe(
        "Filter code modified after this date. ISO format: '2024-01-01'",
      ),
    modifiedBefore: z
      .string()
      .optional()
      .describe(
        "Filter code modified before this date. ISO format: '2024-12-31'",
      ),
    minAgeDays: coerceNumber()
      .optional()
      .describe("Filter code older than N days"),
    maxAgeDays: coerceNumber()
      .optional()
      .describe("Filter code newer than N days"),
    minCommitCount: coerceNumber()
      .optional()
      .describe("Filter by minimum commit count (churn indicator)"),
    taskId: z
      .string()
      .optional()
      .describe("Filter by task/issue ID from commit messages"),
  };
}
```

- [ ] **Step 2: Spread into SemanticSearchSchema and HybridSearchSchema**

```typescript
const SemanticSearchSchema = {
  ...collectionPathFields(),
  ...searchCommonFields(),
  ...typedFilterFields(),
  rerank: ...,
  metaOnly: ...,
};
```

Same for `HybridSearchSchema` and `RankChunksSchema`.

- [ ] **Step 3: Simplify SearchCodeSchema**

Replace the individually listed filter params with `...typedFilterFields()`,
plus the legacy `fileTypes` and `documentationOnly` params:

```typescript
const SearchCodeSchema = {
  path: z.string().describe("Path to codebase (must be indexed first)"),
  query: z.string().describe("Natural language search query"),
  limit: coerceNumber().optional().describe("Maximum number of results (default: 5, max: 100)"),
  pathPattern: z.string().optional().describe(
    "Glob pattern for filtering by file path. Examples: '**/workflow/**', 'src/**/*.ts'.",
  ),
  ...typedFilterFields(),
  fileTypes: z.array(z.string()).optional().describe("Filter by file extensions (e.g., ['.ts', '.py'])"),
  documentationOnly: coerceBoolean().optional().describe(
    "Search only in documentation files. Default: false.",
  ),
  rerank: searchCodeRerankSchema.optional().describe(...),
};
```

- [ ] **Step 4: Run type-check**

Run: `npx tsc --noEmit`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools/schemas.ts
git commit -m "feat(mcp): add typed filter params to all search tool schemas"
```

---

### Task 6: Update MCP handlers to pass typed params

**Files:**

- Modify: `src/mcp/tools/explore.ts`
- Modify: `src/mcp/tools/code.ts`

- [ ] **Step 1: Update semantic_search handler in explore.ts**

Destructure the new typed params and pass them in the request:

```typescript
async ({
  collection, path, query, limit, filter, pathPattern, rerank, metaOnly,
  language, fileExtension, chunkType, isDocumentation, excludeDocumentation,
  author, modifiedAfter, modifiedBefore, minAgeDays, maxAgeDays, minCommitCount, taskId,
}) => {
  const response = await app.semanticSearch({
    collection, path, query, limit, filter, pathPattern,
    rerank: sanitizeRerank(rerank), metaOnly,
    language, fileExtension, chunkType, isDocumentation, excludeDocumentation,
    author, modifiedAfter, modifiedBefore, minAgeDays, maxAgeDays, minCommitCount, taskId,
  });
  ...
```

- [ ] **Step 2: Same for hybrid_search and rank_chunks handlers**

Apply the same pattern.

- [ ] **Step 3: Switch search_code handler to use app.exploreCode**

In `src/mcp/tools/code.ts`, update the `search_code` handler:

```typescript
async ({
  path, query, limit, pathPattern, rerank,
  language, fileExtension, chunkType, isDocumentation, excludeDocumentation,
  author, modifiedAfter, modifiedBefore, minAgeDays, maxAgeDays,
  minCommitCount, taskId, fileTypes, documentationOnly,
}) => {
  try {
    const response = await app.exploreCode({
      path, query, limit, pathPattern,
      rerank: sanitizeRerank(rerank),
      language, fileExtension, chunkType, isDocumentation, excludeDocumentation,
      author, modifiedAfter, modifiedBefore, minAgeDays, maxAgeDays,
      minCommitCount, taskId, fileTypes, documentationOnly,
    });

    if (response.results.length === 0) {
      return formatMcpText(`No results found for query: "${query}"`);
    }

    // Format ExploreResult payload → human-readable text (MCP layer responsibility)
    const formattedResults = response.results
      .map((r, idx) => {
        const p = r.payload ?? {};
        const file = typeof p.relativePath === "string" ? p.relativePath : "unknown";
        const startLine = typeof p.startLine === "number" ? p.startLine : 0;
        const endLine = typeof p.endLine === "number" ? p.endLine : 0;
        const lang = typeof p.language === "string" ? p.language : "unknown";
        const content = typeof p.content === "string" ? p.content : "";

        return (
          `\n--- Result ${idx + 1} (score: ${r.score.toFixed(3)}) ---\n` +
          `File: ${file}:${startLine}-${endLine}\n` +
          `Language: ${lang}\n\n` +
          `${content}\n`
        );
      })
      .join("\n");

    const text = `Found ${response.results.length} result(s):\n${formattedResults}`;
    return appendDriftWarning(formatMcpText(text), response.driftWarning);
  } catch (error) {
    return formatMcpError(error instanceof Error ? error.message : String(error));
  }
},
```

- [ ] **Step 4: Run type-check**

Run: `npx tsc --noEmit`

Expected: PASS

- [ ] **Step 5: Run all tests**

Run: `npx vitest run`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/mcp/tools/explore.ts src/mcp/tools/code.ts
git commit -m "feat(mcp): pass typed filter params, switch search_code to exploreCode"
```

---

## Chunk 5: Cleanup — Delete Legacy Code

### Task 7: Remove excludeDocumentation from ScrollRankStrategy

**Files:**

- Modify: `src/core/explore/strategies/scroll-rank.ts`
- Modify: `tests/core/explore/strategies/scroll-rank.test.ts`

- [ ] **Step 1: Remove excludeDocumentation() from scroll-rank.ts**

In `src/core/explore/strategies/scroll-rank.ts`:

1. Replace `const effectiveFilter = excludeDocumentation(ctx.filter);` with
   `const effectiveFilter = ctx.filter;` in `applyDefaults`.
2. Delete the `excludeDocumentation()` exported function.
3. Remove its import if any.

- [ ] **Step 2: Update scroll-rank tests**

Remove any tests for `excludeDocumentation` function. If
`tests/core/explore/strategies/scroll-rank.test.ts` imports
`excludeDocumentation`, remove those imports and test cases.

- [ ] **Step 3: Search for other usages of excludeDocumentation from
      scroll-rank**

Run: `npx tsc --noEmit 2>&1 | head -20`

Fix any broken imports elsewhere.

- [ ] **Step 4: Run all tests**

Run: `npx vitest run`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/explore/strategies/scroll-rank.ts tests/core/explore/strategies/scroll-rank.test.ts
git commit -m "refactor(explore): remove excludeDocumentation from ScrollRankStrategy (now via typed filter)"
```

---

### Task 8: Delete ExploreModule, legacy types, update all tests

This task is atomic — all deletions and test updates in one commit to avoid
broken intermediate states.

**Files:**

- Delete: `src/core/explore/explore-module.ts`
- Delete: `tests/core/explore/explore-module.test.ts`
- Modify: `src/core/types.ts` — remove `ExploreCodeConfig`, `SearchOptions`,
  `CodeSearchResult`
- Modify: `src/core/api/explore-facade.ts` — remove `searchCode`,
  `searchCodeTyped`, `toSearchResults`, ExploreModule imports
- Modify: `src/core/api/app.ts` — remove `searchCode` from interface, clean
  re-exports
- Modify: `src/core/api/create-app.ts` — remove `searchCode` mapping
- Modify: `src/core/contracts/types/app.ts` — remove backward compat aliases
  (`SearchResponse`, `SearchCodeResponse`, `SearchCodeRequest`,
  `SearchCodeResult`), remove `SearchResult` (replace with ExploreResult usage)
- Modify: `src/bootstrap/config/index.ts` — remove `exploreCode` from
  `AppConfig`
- Modify: `src/bootstrap/factory.ts` — remove `config.exploreCode` usage, update
  `ExploreFacade` constructor (remove config param)
- Modify: `src/core/api/explore-facade.ts` — remove `config` constructor param
- Update: `tests/core/api/explore-facade.test.ts`
- Update: `tests/core/api/explore-facade-expanded.test.ts`
- Update: `tests/core/api/explore-facade-filter.test.ts`
- Update: `tests/core/api/explore-facade-explore-code.test.ts`
- Update: `tests/core/api/create-app.test.ts`
- Update: `tests/integration/integration.test.ts`

- [ ] **Step 1: Delete explore-module.ts and its test**

```bash
rm src/core/explore/explore-module.ts tests/core/explore/explore-module.test.ts
```

- [ ] **Step 2: Remove legacy types from core/types.ts**

Remove `ExploreCodeConfig`, `SearchOptions`, and `CodeSearchResult` interfaces.

- [ ] **Step 3: Remove ExploreCodeConfig from bootstrap**

In `src/bootstrap/config/index.ts`:

- Remove `exploreCode: ExploreCodeConfig` from `AppConfig`
- Remove the `exploreCode` block from `parseAppConfig()`
- Remove import of `ExploreCodeConfig`

In `src/bootstrap/factory.ts`:

- Remove `config.exploreCode` from `ExploreFacade` constructor call
- Update to not pass the legacy config arg

- [ ] **Step 4: Update ExploreFacade constructor — remove config param**

In `src/core/api/explore-facade.ts`:

- Remove `config: ExploreCodeConfig` from constructor params
- Remove `searchCode()` and `searchCodeTyped()` methods
- Remove `toSearchResults()` method
- Remove `ExploreModule` import
- Remove import of `ExploreCodeConfig`
- Update `executeExplore` to return `ExploreResult[]` directly:

```typescript
private async executeExplore(
  strategy: BaseExploreStrategy,
  ctx: ExploreContext,
  path?: string,
): Promise<ExploreResponse> {
  await this.validateCollectionExists(ctx.collectionName, path);
  await this.ensureStats(ctx.collectionName);
  const results = await strategy.execute(ctx);
  const driftWarning = await this.checkDrift(path, ctx.collectionName);
  return { results, driftWarning };
}
```

Note: `ExploreResponse.results` type changes from `SearchResult[]` to
`ExploreResult[]`. Update `ExploreResponse` in contracts to use `ExploreResult`:

In `src/core/contracts/types/app.ts`, update `ExploreResponse`:

```typescript
import type { RankingOverlay } from "./reranker.js";

export interface ExploreResult {
  id?: string | number;
  score: number;
  payload?: Record<string, unknown>;
  rankingOverlay?: RankingOverlay;
}

export interface ExploreResponse {
  results: ExploreResult[];
  driftWarning: string | null;
}
```

This `ExploreResult` in contracts is a copy of the one in
`explore/strategies/types.ts`. To avoid duplication, have
`explore/strategies/types.ts` import from contracts instead:

In `src/core/explore/strategies/types.ts`:

- Remove the `ExploreResult` interface definition
- Add: `export type { ExploreResult } from "../../contracts/types/app.js";`

This respects layering: explore/ imports from contracts/ (allowed).

- [ ] **Step 5: Remove searchCode from App interface and create-app.ts**

In `src/core/api/app.ts`:

- Remove `searchCode` from App interface
- Remove `SearchCodeResponse`, `SearchCodeResult`, `SearchCodeRequest` from
  re-exports

In `src/core/api/create-app.ts`:

- Remove `searchCode` mapping

- [ ] **Step 6: Remove backward compat aliases from contracts/types/app.ts**

Remove:

- `SearchResponse` alias
- `SearchCodeResponse` alias
- `SearchCodeRequest` alias
- `SearchCodeResult` interface
- `SearchResult` interface (now replaced by `ExploreResult`)

- [ ] **Step 7: Update all test files**

Update these test files to:

- Remove `ExploreCodeConfig` from constructor args (9 → 8 params)
- Replace `searchCodeTyped`/`searchCode` with `exploreCode`
- Update type imports (`SearchResponse` → `ExploreResponse`, etc.)
- Remove ExploreModule mock references

Files:

- `tests/core/api/explore-facade.test.ts`
- `tests/core/api/explore-facade-expanded.test.ts`
- `tests/core/api/explore-facade-filter.test.ts`
- `tests/core/api/explore-facade-explore-code.test.ts`
- `tests/core/api/create-app.test.ts`
- `tests/integration/integration.test.ts`

- [ ] **Step 8: Fix any remaining import errors**

Run: `npx tsc --noEmit 2>&1 | head -60`

Fix all broken imports.

- [ ] **Step 9: Run all tests**

Run: `npx vitest run`

Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add src/core/explore/explore-module.ts src/core/types.ts src/core/contracts/types/app.ts src/core/api/explore-facade.ts src/core/api/app.ts src/core/api/create-app.ts src/core/explore/strategies/types.ts src/bootstrap/config/index.ts src/bootstrap/factory.ts tests/
git commit -m "refactor(explore): delete ExploreModule, legacy types, consolidate ExploreResult/ExploreResponse"
```

---

### Task 9: Final verification

- [ ] **Step 1: Full type-check**

Run: `npx tsc --noEmit`

Expected: PASS

- [ ] **Step 2: Lint**

Run: `npx prettier --check "src/**/*.ts" "tests/**/*.ts"`

Expected: PASS (or fix any issues)

- [ ] **Step 3: Full test suite**

Run: `npx vitest run`

Expected: PASS

- [ ] **Step 4: Commit any fixes**

```bash
git add src/ tests/
git commit -m "chore: fix lint and type-check after unified filter migration"
```
