# find_symbol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dedicated `find_symbol` MCP tool that resolves symbols by name
via Qdrant scroll (no embedding), with chunk merging for functions and outline
for classes.

**Architecture:** New `symbol-resolve.ts` in `domains/explore/` holds pure merge
and outline logic. `ExploreFacade.findSymbol()` orchestrates scroll + resolve.
New `QdrantManager.scrollFiltered()` method provides filter-based scroll without
ordering. MCP tool registered in `explore.ts` alongside other search tools.

**Tech Stack:** TypeScript, Qdrant scroll API, Zod schemas, Vitest

**Spec:** `docs/superpowers/specs/2026-03-26-find-symbol-design.md`

---

### Task 1: Add `QdrantManager.scrollFiltered()` adapter method

Qdrant client currently has `scrollOrdered()` (with `order_by`) and
`scrollFieldValues()` (single field). `find_symbol` needs a simple scroll with
filter, returning full payloads.

**Files:**

- Modify: `src/core/adapters/qdrant/client.ts`
- Test: `tests/core/adapters/qdrant/client-scroll-filtered.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/core/adapters/qdrant/client-scroll-filtered.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

import { QdrantManager } from "../../../../src/core/adapters/qdrant/client.js";

// Mock the Qdrant JS client
const mockScroll = vi.fn();
vi.mock("@qdrant/js-client-rest", () => ({
  QdrantClient: vi.fn().mockImplementation(() => ({
    scroll: mockScroll,
    getCollections: vi.fn().mockResolvedValue({ collections: [] }),
  })),
}));

describe("QdrantManager.scrollFiltered", () => {
  let manager: QdrantManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new QdrantManager("http://localhost:6333");
  });

  it("returns points matching filter with full payloads", async () => {
    mockScroll.mockResolvedValue({
      points: [
        {
          id: "uuid-1",
          payload: {
            symbolId: "Reranker.score",
            content: "function score() {}",
            relativePath: "src/reranker.ts",
            startLine: 10,
            endLine: 20,
          },
        },
        {
          id: "uuid-2",
          payload: {
            symbolId: "Reranker.rerank",
            content: "function rerank() {}",
            relativePath: "src/reranker.ts",
            startLine: 30,
            endLine: 50,
          },
        },
      ],
      next_page_offset: null,
    });

    const filter = {
      must: [{ key: "symbolId", match: { text: "Reranker" } }],
    };
    const results = await manager.scrollFiltered(
      "test_collection",
      filter,
      100,
    );

    expect(results).toHaveLength(2);
    expect(results[0].id).toBe("uuid-1");
    expect(results[0].payload.symbolId).toBe("Reranker.score");
    expect(results[1].id).toBe("uuid-2");

    expect(mockScroll).toHaveBeenCalledWith("test_collection", {
      limit: 100,
      with_payload: true,
      with_vector: false,
      filter,
    });
  });

  it("paginates when next_page_offset is present", async () => {
    mockScroll
      .mockResolvedValueOnce({
        points: [{ id: "uuid-1", payload: { symbolId: "A" } }],
        next_page_offset: "uuid-1",
      })
      .mockResolvedValueOnce({
        points: [{ id: "uuid-2", payload: { symbolId: "B" } }],
        next_page_offset: null,
      });

    const results = await manager.scrollFiltered(
      "test_collection",
      { must: [{ key: "symbolId", match: { text: "test" } }] },
      100,
    );

    expect(results).toHaveLength(2);
    expect(mockScroll).toHaveBeenCalledTimes(2);
  });

  it("skips points with null payloads", async () => {
    mockScroll.mockResolvedValue({
      points: [
        { id: "uuid-1", payload: null },
        { id: "uuid-2", payload: { symbolId: "Valid" } },
      ],
      next_page_offset: null,
    });

    const results = await manager.scrollFiltered(
      "test_collection",
      { must: [{ key: "symbolId", match: { text: "test" } }] },
      100,
    );

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("uuid-2");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/adapters/qdrant/client-scroll-filtered.test.ts`
Expected: FAIL — `scrollFiltered` is not a function

- [ ] **Step 3: Implement `scrollFiltered`**

Add to `src/core/adapters/qdrant/client.ts` after `scrollOrdered()` (line
~1090):

```typescript
  /**
   * Scroll points matching a filter. Returns points with IDs and full payloads.
   * No ordering — results come in Qdrant internal order.
   * Paginates automatically until all matching points are returned.
   */
  async scrollFiltered(
    collectionName: string,
    filter: Record<string, unknown>,
    limit: number,
  ): Promise<{ id: string | number; payload: Record<string, unknown> }[]> {
    const results: { id: string | number; payload: Record<string, unknown> }[] = [];
    let offset: string | number | undefined = undefined;

    do {
      const result = await this.call(async () =>
        this.client.scroll(collectionName, {
          limit,
          with_payload: true,
          with_vector: false,
          filter,
          ...(offset !== undefined ? { offset } : {}),
        }),
      );

      for (const point of result.points) {
        if (point.payload !== null && point.payload !== undefined) {
          results.push({
            id: point.id,
            payload: point.payload as Record<string, unknown>,
          });
        }
      }

      const next = result.next_page_offset;
      offset = typeof next === "string" || typeof next === "number" ? next : undefined;
    } while (offset !== undefined);

    return results;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/adapters/qdrant/client-scroll-filtered.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/adapters/qdrant/client.ts tests/core/adapters/qdrant/client-scroll-filtered.test.ts
git commit -m "feat(qdrant): add QdrantManager.scrollFiltered() for filter-based scroll"
```

---

### Task 2: Add `FindSymbolRequest` DTO

**Files:**

- Modify: `src/core/api/public/dto/explore.ts`
- Modify: `src/core/api/public/dto/index.ts`

- [ ] **Step 1: Add `FindSymbolRequest` to `explore.ts`**

Add after `FindSimilarRequest` (line ~116):

```typescript
/**
 * Find symbol by name — direct Qdrant scroll, no embedding.
 * Returns merged definition for functions, outline for classes.
 */
export interface FindSymbolRequest extends CollectionRef {
  symbol: string;
  language?: string;
  pathPattern?: string;
}
```

- [ ] **Step 2: Re-export from DTO barrel**

In `src/core/api/public/dto/index.ts`, add `FindSymbolRequest` to the explore
re-exports:

```typescript
export type {
  // Explore
  CollectionRef,
  TypedFilterParams,
  SemanticSearchRequest,
  HybridSearchRequest,
  RankChunksRequest,
  ExploreCodeRequest,
  FindSimilarRequest,
  FindSymbolRequest,
  SearchResult,
  ExploreResponse,
  SignalDescriptor,
  PresetDetail,
  PresetDescriptors,
} from "./explore.js";
```

- [ ] **Step 3: Commit**

```bash
git add src/core/api/public/dto/explore.ts src/core/api/public/dto/index.ts
git commit -m "feat(api): add FindSymbolRequest DTO"
```

---

### Task 3: Implement `symbol-resolve.ts` domain logic

Pure functions — no Qdrant dependency, no I/O. Takes raw scroll results, returns
merged/outlined `SearchResult[]`.

**Files:**

- Create: `src/core/domains/explore/symbol-resolve.ts`
- Test: `tests/core/domains/explore/symbol-resolve.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/core/domains/explore/symbol-resolve.test.ts
import { describe, expect, it } from "vitest";

import { resolveSymbols } from "../../../../src/core/domains/explore/symbol-resolve.js";

describe("resolveSymbols", () => {
  describe("function merge strategy", () => {
    it("merges multiple chunks of the same function into one result", () => {
      const chunks = [
        {
          id: "uuid-1",
          payload: {
            symbolId: "processData",
            chunkType: "function",
            relativePath: "src/processor.ts",
            content:
              "function processData(input: string) {\n  const parsed = parse(input);",
            startLine: 10,
            endLine: 20,
            language: "typescript",
            git: { file: { commitCount: 5, ageDays: 30 } },
          },
        },
        {
          id: "uuid-2",
          payload: {
            symbolId: "processData",
            chunkType: "function",
            relativePath: "src/processor.ts",
            content: "  return transform(parsed);\n}",
            startLine: 21,
            endLine: 25,
            language: "typescript",
            git: { file: { commitCount: 5, ageDays: 30 } },
          },
        },
      ];

      const results = resolveSymbols(chunks);

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("uuid-1");
      expect(results[0].score).toBe(1.0);
      expect(results[0].payload?.symbolId).toBe("processData");
      expect(results[0].payload?.startLine).toBe(10);
      expect(results[0].payload?.endLine).toBe(25);
      expect(results[0].payload?.mergedChunkIds).toEqual(["uuid-1", "uuid-2"]);
      expect(results[0].payload?.content).toContain("function processData");
      expect(results[0].payload?.content).toContain("return transform");
      expect(results[0].payload?.git).toEqual({
        file: { commitCount: 5, ageDays: 30 },
      });
    });

    it("returns single chunk as-is without mergedChunkIds", () => {
      const chunks = [
        {
          id: "uuid-1",
          payload: {
            symbolId: "simpleFunc",
            chunkType: "function",
            relativePath: "src/utils.ts",
            content: "function simpleFunc() { return 42; }",
            startLine: 1,
            endLine: 1,
            language: "typescript",
            git: { file: { ageDays: 10 } },
          },
        },
      ];

      const results = resolveSymbols(chunks);

      expect(results).toHaveLength(1);
      expect(results[0].payload?.mergedChunkIds).toBeUndefined();
    });
  });

  describe("class outline strategy", () => {
    it("returns class chunk with members list", () => {
      const chunks = [
        {
          id: "class-uuid",
          payload: {
            symbolId: "Reranker",
            chunkType: "class",
            name: "Reranker",
            relativePath: "src/reranker.ts",
            content: "class Reranker {\n  constructor(deps: Deps) {}",
            startLine: 10,
            endLine: 25,
            language: "typescript",
            git: { file: { commitCount: 15, ageDays: 60 } },
          },
        },
        {
          id: "method-1",
          payload: {
            symbolId: "Reranker.score",
            chunkType: "function",
            parentName: "Reranker",
            relativePath: "src/reranker.ts",
            content: "score() { ... }",
            startLine: 30,
            endLine: 50,
            language: "typescript",
            git: { file: { commitCount: 15, ageDays: 60 } },
          },
        },
        {
          id: "method-2",
          payload: {
            symbolId: "Reranker.rerank",
            chunkType: "function",
            parentName: "Reranker",
            relativePath: "src/reranker.ts",
            content: "rerank() { ... }",
            startLine: 55,
            endLine: 80,
            language: "typescript",
            git: { file: { commitCount: 15, ageDays: 60 } },
          },
        },
      ];

      const results = resolveSymbols(chunks);

      // Class result + method results are separate
      const classResult = results.find((r) => r.payload?.chunkType === "class");
      expect(classResult).toBeDefined();
      expect(classResult!.payload?.members).toEqual([
        "Reranker.score",
        "Reranker.rerank",
      ]);
      expect(classResult!.payload?.git).toEqual({
        file: { commitCount: 15, ageDays: 60 },
      });
    });
  });

  describe("sorting", () => {
    it("sorts exact symbolId matches before partial matches", () => {
      const chunks = [
        {
          id: "uuid-partial",
          payload: {
            symbolId: "Reranker.score",
            chunkType: "function",
            relativePath: "src/reranker.ts",
            content: "score() {}",
            startLine: 30,
            endLine: 50,
            language: "typescript",
          },
        },
        {
          id: "uuid-exact",
          payload: {
            symbolId: "Reranker",
            chunkType: "class",
            name: "Reranker",
            relativePath: "src/reranker.ts",
            content: "class Reranker {}",
            startLine: 1,
            endLine: 5,
            language: "typescript",
          },
        },
      ];

      const results = resolveSymbols(chunks, "Reranker");

      expect(results[0].payload?.symbolId).toBe("Reranker");
    });

    it("sorts alphabetically by path for same match rank", () => {
      const chunks = [
        {
          id: "uuid-b",
          payload: {
            symbolId: "score",
            chunkType: "function",
            relativePath: "src/b/scorer.ts",
            content: "function score() {}",
            startLine: 1,
            endLine: 5,
            language: "typescript",
          },
        },
        {
          id: "uuid-a",
          payload: {
            symbolId: "score",
            chunkType: "function",
            relativePath: "src/a/scorer.ts",
            content: "function score() {}",
            startLine: 1,
            endLine: 5,
            language: "typescript",
          },
        },
      ];

      const results = resolveSymbols(chunks, "score");

      expect(results[0].payload?.relativePath).toBe("src/a/scorer.ts");
    });
  });

  describe("mixed results", () => {
    it("handles functions from different files separately", () => {
      const chunks = [
        {
          id: "uuid-1",
          payload: {
            symbolId: "validate",
            chunkType: "function",
            relativePath: "src/auth.ts",
            content: "function validate() {}",
            startLine: 1,
            endLine: 5,
            language: "typescript",
          },
        },
        {
          id: "uuid-2",
          payload: {
            symbolId: "validate",
            chunkType: "function",
            relativePath: "src/input.ts",
            content: "function validate() {}",
            startLine: 1,
            endLine: 5,
            language: "typescript",
          },
        },
      ];

      const results = resolveSymbols(chunks, "validate");

      expect(results).toHaveLength(2);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/domains/explore/symbol-resolve.test.ts`
Expected: FAIL — cannot resolve `symbol-resolve.js`

- [ ] **Step 3: Implement `symbol-resolve.ts`**

Create `src/core/domains/explore/symbol-resolve.ts`:

```typescript
/**
 * Symbol resolution — pure functions for merging/outlining chunks
 * returned by Qdrant scroll into find_symbol results.
 *
 * No I/O, no Qdrant dependency.
 */

import type { SearchResult } from "../../api/public/dto/explore.js";

interface ScrollChunk {
  id: string | number;
  payload: Record<string, unknown>;
}

/**
 * Resolve raw scroll chunks into find_symbol results.
 *
 * Strategy per group (same symbolId + same relativePath):
 * - chunkType "class" → outline with members[]
 * - anything else → merge chunks by startLine order
 *
 * @param chunks - raw Qdrant scroll results
 * @param query - original symbol query (for sort priority)
 */
export function resolveSymbols(
  chunks: ScrollChunk[],
  query?: string,
): SearchResult[] {
  // Group by (symbolId, relativePath)
  const groups = groupChunks(chunks);
  const results: SearchResult[] = [];

  for (const group of groups.values()) {
    const classChunk = group.find((c) => c.payload.chunkType === "class");

    if (classChunk) {
      // Class outline: attach members from same file
      const memberChunks = group.filter(
        (c) =>
          c.payload.parentName === classChunk.payload.name && c !== classChunk,
      );
      results.push(outlineClass(classChunk, memberChunks));
      // Also emit non-member, non-class chunks (e.g., matched methods from other classes)
      const remaining = group.filter(
        (c) => c !== classChunk && !memberChunks.includes(c),
      );
      if (remaining.length > 0) {
        results.push(mergeChunks(remaining));
      }
    } else {
      results.push(mergeChunks(group));
    }
  }

  return sortResults(results, query);
}

/** Group chunks by (symbolId, relativePath) composite key. */
function groupChunks(chunks: ScrollChunk[]): Map<string, ScrollChunk[]> {
  const groups = new Map<string, ScrollChunk[]>();
  for (const chunk of chunks) {
    const symbolId = String(chunk.payload.symbolId ?? "");
    const path = String(chunk.payload.relativePath ?? "");
    const key = `${symbolId}::${path}`;
    const group = groups.get(key);
    if (group) {
      group.push(chunk);
    } else {
      groups.set(key, [chunk]);
    }
  }
  return groups;
}

/** Merge multiple chunks of the same function into one result. */
function mergeChunks(chunks: ScrollChunk[]): SearchResult {
  const sorted = [...chunks].sort(
    (a, b) =>
      (Number(a.payload.startLine) || 0) - (Number(b.payload.startLine) || 0),
  );

  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const content = sorted.map((c) => String(c.payload.content ?? "")).join("\n");

  const payload: Record<string, unknown> = {
    ...first.payload,
    content,
    startLine: first.payload.startLine,
    endLine: last.payload.endLine,
    git: first.payload.git
      ? { file: (first.payload.git as Record<string, unknown>).file }
      : undefined,
  };

  if (sorted.length > 1) {
    payload.mergedChunkIds = sorted.map((c) => c.id);
  }

  return { id: first.id, score: 1.0, payload };
}

/** Outline a class: class chunk + members list. */
function outlineClass(
  classChunk: ScrollChunk,
  memberChunks: ScrollChunk[],
): SearchResult {
  const members = memberChunks
    .sort(
      (a, b) =>
        (Number(a.payload.startLine) || 0) - (Number(b.payload.startLine) || 0),
    )
    .map((c) => String(c.payload.symbolId ?? ""));

  const payload: Record<string, unknown> = {
    ...classChunk.payload,
    git: classChunk.payload.git
      ? { file: (classChunk.payload.git as Record<string, unknown>).file }
      : undefined,
    ...(members.length > 0 ? { members } : {}),
  };

  return { id: classChunk.id, score: 1.0, payload };
}

/** Sort: exact symbolId match first, then alphabetical by path. */
function sortResults(results: SearchResult[], query?: string): SearchResult[] {
  if (!query) return results;
  const q = query.toLowerCase();
  return results.sort((a, b) => {
    const aExact =
      String(a.payload?.symbolId ?? "").toLowerCase() === q ? 0 : 1;
    const bExact =
      String(b.payload?.symbolId ?? "").toLowerCase() === q ? 0 : 1;
    if (aExact !== bExact) return aExact - bExact;
    const aPath = String(a.payload?.relativePath ?? "");
    const bPath = String(b.payload?.relativePath ?? "");
    return aPath.localeCompare(bPath);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/domains/explore/symbol-resolve.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/explore/symbol-resolve.ts tests/core/domains/explore/symbol-resolve.test.ts
git commit -m "feat(explore): add symbol-resolve.ts with merge and outline strategies"
```

---

### Task 4: Add `ExploreFacade.findSymbol()` and wire App interface

**Files:**

- Modify: `src/core/api/internal/facades/explore-facade.ts`
- Modify: `src/core/api/public/app.ts`
- Test: `tests/core/api/internal/facades/explore-facade-find-symbol.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/core/api/internal/facades/explore-facade-find-symbol.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ExploreFacade } from "../../../../../src/core/api/internal/facades/explore-facade.js";

vi.mock("tree-sitter", () => ({
  default: class MockParser {
    parse() {
      return { rootNode: { type: "program", children: [], text: "" } };
    }
  },
}));
vi.mock("tree-sitter-typescript", () => ({
  default: { typescript: {}, tsx: {} },
}));

describe("ExploreFacade.findSymbol", () => {
  let facade: ExploreFacade;
  const mockScrollFiltered = vi.fn();
  const mockCollectionExists = vi.fn().mockResolvedValue(true);

  beforeEach(() => {
    vi.clearAllMocks();
    mockScrollFiltered.mockResolvedValue([
      {
        id: "uuid-1",
        payload: {
          symbolId: "Reranker.score",
          chunkType: "function",
          relativePath: "src/reranker.ts",
          content: "score() { return 42; }",
          startLine: 30,
          endLine: 50,
          language: "typescript",
          git: { file: { commitCount: 5 } },
        },
      },
    ]);

    facade = new ExploreFacade({
      qdrant: {
        scrollFiltered: mockScrollFiltered,
        collectionExists: mockCollectionExists,
      } as any,
      embeddings: {} as any,
      reranker: {
        getPresetNames: vi.fn().mockReturnValue([]),
        getPresetDetails: vi.fn().mockReturnValue([]),
        getDescriptorInfo: vi.fn().mockReturnValue([]),
        ensureStats: vi.fn(),
      } as any,
      registry: {
        buildMergedFilter: vi.fn().mockReturnValue(undefined),
      } as any,
    });
  });

  it("returns resolved symbols from scroll results", async () => {
    const result = await facade.findSymbol({
      symbol: "Reranker.score",
      collection: "test_collection",
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0].payload?.symbolId).toBe("Reranker.score");
    expect(result.results[0].score).toBe(1.0);
  });

  it("builds symbolId text match filter", async () => {
    await facade.findSymbol({
      symbol: "Reranker",
      collection: "test_collection",
    });

    expect(mockScrollFiltered).toHaveBeenCalledWith(
      "test_collection",
      expect.objectContaining({
        must: expect.arrayContaining([
          { key: "symbolId", match: { text: "Reranker" } },
        ]),
      }),
      expect.any(Number),
    );
  });

  it("includes language filter when provided", async () => {
    await facade.findSymbol({
      symbol: "validate",
      collection: "test_collection",
      language: "typescript",
    });

    expect(mockScrollFiltered).toHaveBeenCalledWith(
      "test_collection",
      expect.objectContaining({
        must: expect.arrayContaining([
          { key: "symbolId", match: { text: "validate" } },
          { key: "language", match: { value: "typescript" } },
        ]),
      }),
      expect.any(Number),
    );
  });

  it("returns empty results when no symbols match", async () => {
    mockScrollFiltered.mockResolvedValue([]);

    const result = await facade.findSymbol({
      symbol: "nonexistent",
      collection: "test_collection",
    });

    expect(result.results).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
`npx vitest run tests/core/api/internal/facades/explore-facade-find-symbol.test.ts`
Expected: FAIL — `findSymbol` is not a function

- [ ] **Step 3: Add `findSymbol` to `ExploreFacade`**

In `src/core/api/internal/facades/explore-facade.ts`, add import at top:

```typescript
import { resolveSymbols } from "../../../domains/explore/symbol-resolve.js";
```

Add import for `FindSymbolRequest`:

```typescript
import type {
  // ... existing imports ...
  FindSymbolRequest,
} from "../../public/dto/index.js";
```

Add method to `ExploreFacade` class (after `findSimilar`):

```typescript
  /** Find symbol by name — direct Qdrant scroll, no embedding. */
  async findSymbol(request: FindSymbolRequest): Promise<ExploreResponse> {
    const { collectionName, path } = await this.resolveAndGuard(request.collection, request.path);

    // Build filter: symbolId text match + optional language + optional pathPattern
    const must: Record<string, unknown>[] = [
      { key: "symbolId", match: { text: request.symbol } },
    ];
    if (request.language) {
      must.push({ key: "language", match: { value: request.language } });
    }

    let filter: Record<string, unknown> = { must };

    // Merge pathPattern filter if present
    if (request.pathPattern) {
      const pathFilter = this.registry.buildMergedFilter(
        { pathPattern: request.pathPattern } as unknown as Record<string, unknown>,
        undefined,
        "chunk",
      );
      if (pathFilter) {
        const existing = filter.must as Record<string, unknown>[];
        const extra = (pathFilter as Record<string, unknown>).must as Record<string, unknown>[] | undefined;
        if (extra) existing.push(...extra);
      }
    }

    // Also collect parentName matches for class outline (members)
    const parentFilter: Record<string, unknown> = {
      must: [
        { key: "parentName", match: { text: request.symbol } },
        ...(request.language ? [{ key: "language", match: { value: request.language } }] : []),
      ],
    };

    // Execute both scrolls in parallel
    const [symbolChunks, memberChunks] = await Promise.all([
      this.qdrant.scrollFiltered(collectionName, filter, 200),
      this.qdrant.scrollFiltered(collectionName, parentFilter, 200),
    ]);

    // Deduplicate (a chunk may appear in both if its symbolId and parentName both match)
    const seen = new Set(symbolChunks.map((c) => c.id));
    const allChunks = [
      ...symbolChunks,
      ...memberChunks.filter((c) => !seen.has(c.id)),
    ];

    const results = resolveSymbols(allChunks, request.symbol);
    const driftWarning = path ? await this.checkDrift(path) : null;

    return { results, driftWarning };
  }
```

- [ ] **Step 4: Add `findSymbol` to App interface and factory**

In `src/core/api/public/app.ts`, add to imports:

```typescript
import type {
  // ... existing imports ...
  FindSymbolRequest,
} from "./dto/index.js";
```

Add to `App` interface (after `findSimilar`):

```typescript
findSymbol: (request: FindSymbolRequest) => Promise<ExploreResponse>;
```

Add to `createApp()` return object (after `findSimilar` delegation):

```typescript
    findSymbol: async (req) => deps.explore.findSymbol(req),
```

- [ ] **Step 5: Run test to verify it passes**

Run:
`npx vitest run tests/core/api/internal/facades/explore-facade-find-symbol.test.ts`
Expected: PASS

- [ ] **Step 6: Run full test suite**

Run: `npx vitest run` Expected: All tests pass

- [ ] **Step 7: Commit**

```bash
git add src/core/api/internal/facades/explore-facade.ts src/core/api/public/app.ts tests/core/api/internal/facades/explore-facade-find-symbol.test.ts
git commit -m "feat(explore): add ExploreFacade.findSymbol() with scroll + resolve pipeline"
```

---

### Task 5: Register `find_symbol` MCP tool

**Files:**

- Modify: `src/mcp/tools/schemas.ts`
- Modify: `src/mcp/tools/explore.ts`

- [ ] **Step 1: Add Zod schema to `schemas.ts`**

Add after `GetIndexMetricsSchema` (static schemas section, line ~100):

```typescript
// ---------------------------------------------------------------------------
// Symbol lookup schema (static — no dynamic presets needed)
// ---------------------------------------------------------------------------

export const FindSymbolSchema = {
  symbol: z
    .string()
    .describe(
      "Symbol name or symbolId to find. Format: 'ClassName.methodName' for class methods, " +
        "'functionName' for top-level functions, 'ClassName' for classes. " +
        "Supports partial match: 'ClassName' finds the class and all its methods.",
    ),
  ...collectionPathFields(),
  language: z
    .string()
    .optional()
    .describe(
      "Filter by programming language (for disambiguation in polyglot codebases)",
    ),
  pathPattern: z
    .string()
    .optional()
    .describe(
      "Glob pattern for filtering by file path (picomatch). Example: '**/services/**'",
    ),
};
```

Note: `collectionPathFields()` is already defined in schemas.ts, reuse it.

- [ ] **Step 2: Register MCP tool in `explore.ts`**

Add at the end of `registerSearchTools()` function in
`src/mcp/tools/explore.ts`, after the last `registerToolSafe` call:

```typescript
// find_symbol
registerToolSafe(
  server,
  "find_symbol",
  {
    title: "Find Symbol",
    description:
      "Find symbol by name — direct lookup, no embedding. " +
      "Returns merged definition for functions (chunks joined), outline + members for classes. " +
      "Uses Qdrant text match on symbolId field. Partial match supported: " +
      "'Reranker' finds the class and all its methods.",
    inputSchema: FindSymbolSchema,
    outputSchema: SearchResultOutputSchema,
    annotations: { readOnlyHint: true },
  },
  async (params) => {
    const response = await app.findSymbol({
      symbol: params.symbol as string,
      collection: params.collection as string | undefined,
      path: params.path as string | undefined,
      language: params.language as string | undefined,
      pathPattern: params.pathPattern as string | undefined,
    });
    return formatStructuredResult(response);
  },
);
```

Add `FindSymbolSchema` to the import from `./schemas.js`:

```typescript
import { createSearchSchemas, FindSymbolSchema } from "./schemas.js";
```

- [ ] **Step 3: Build and verify**

Run: `npm run build && npx vitest run` Expected: Build succeeds, all tests pass

- [ ] **Step 4: Commit**

```bash
git add src/mcp/tools/schemas.ts src/mcp/tools/explore.ts
git commit -m "feat(mcp): register find_symbol tool with Zod schema"
```

---

### Task 6: Integration test (end-to-end via MCP reconnect)

**Files:**

- No new files — uses MCP tools directly after rebuild

- [ ] **Step 1: Rebuild**

Run: `npm run build`

- [ ] **Step 2: Request MCP reconnect**

Ask user to reconnect tea-rags MCP server.

- [ ] **Step 3: Test basic symbol lookup**

Call `find_symbol` with:

```json
{
  "symbol": "Reranker",
  "path": "/Users/artk0re/Dev/Tools/tea-rags-mcp"
}
```

Expected: class chunk with `members` array listing Reranker methods.

- [ ] **Step 4: Test method lookup**

Call `find_symbol` with:

```json
{
  "symbol": "resolveSymbols",
  "path": "/Users/artk0re/Dev/Tools/tea-rags-mcp"
}
```

Expected: single function result from `symbol-resolve.ts`.

- [ ] **Step 5: Test partial match with language filter**

Call `find_symbol` with:

```json
{
  "symbol": "score",
  "path": "/Users/artk0re/Dev/Tools/tea-rags-mcp",
  "language": "typescript"
}
```

Expected: multiple results from different files where symbolId contains "score".
