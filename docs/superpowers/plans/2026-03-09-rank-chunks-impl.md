# rank_chunks Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to
> implement this plan task-by-task.

**Goal:** Add `rank_chunks` MCP tool that ranks collection chunks by rerank
signals without vector search, using scatter-gather ordered scroll.

**Architecture:** New `RankModule` in `core/search/` orchestrates: preset
weights → resolve order_by fields from `DerivedSignalDescriptor.sources` +
`inverted` → parallel Qdrant scroll → merge/deduplicate → existing
`Reranker.rerank()` with similarity zeroed out. Low-level scroll with `order_by`
added to `adapters/qdrant/scroll.ts`.

**Tech Stack:** TypeScript, Qdrant REST API (`order_by` in scroll), Zod schemas,
vitest

---

### Task 1: Add `inverted` field to `DerivedSignalDescriptor`

**Files:**

- Modify: `src/core/contracts/types/reranker.ts:12-26`
- Modify: `src/core/trajectory/git/rerank/derived-signals/recency.ts`
- Modify: `src/core/trajectory/git/rerank/derived-signals/stability.ts`
- Modify: `src/core/trajectory/git/rerank/derived-signals/block-penalty.ts`
- Test: `tests/core/contracts/types/inverted-signals.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";

import { AgeSignal } from "../../../../src/core/trajectory/git/rerank/derived-signals/age.js";
import { BlockPenaltySignal } from "../../../../src/core/trajectory/git/rerank/derived-signals/block-penalty.js";
import { ChurnSignal } from "../../../../src/core/trajectory/git/rerank/derived-signals/churn.js";
import { RecencySignal } from "../../../../src/core/trajectory/git/rerank/derived-signals/recency.js";
import { StabilitySignal } from "../../../../src/core/trajectory/git/rerank/derived-signals/stability.js";
import { ChunkSizeSignal } from "../../../../src/core/trajectory/static/rerank/derived-signals/chunk-size.js";

describe("DerivedSignalDescriptor.inverted", () => {
  it("RecencySignal is inverted (1 - normalize)", () => {
    const signal = new RecencySignal();
    expect(signal.inverted).toBe(true);
  });

  it("StabilitySignal is inverted (1 - normalize)", () => {
    const signal = new StabilitySignal();
    expect(signal.inverted).toBe(true);
  });

  it("BlockPenaltySignal is inverted", () => {
    const signal = new BlockPenaltySignal();
    expect(signal.inverted).toBe(true);
  });

  it("ChurnSignal is not inverted", () => {
    const signal = new ChurnSignal();
    expect(signal.inverted).toBeUndefined();
  });

  it("AgeSignal is not inverted", () => {
    const signal = new AgeSignal();
    expect(signal.inverted).toBeUndefined();
  });

  it("ChunkSizeSignal is not inverted", () => {
    const signal = new ChunkSizeSignal();
    expect(signal.inverted).toBeUndefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/contracts/types/inverted-signals.test.ts`
Expected: FAIL — `inverted` property does not exist

**Step 3: Write minimal implementation**

In `src/core/contracts/types/reranker.ts`, add to `DerivedSignalDescriptor`:

```typescript
/** Whether this signal inverts the raw value (1 - normalize pattern).
 *  Used by rank_chunks to determine scroll direction: inverted=true → asc. */
inverted?: boolean;
```

In `src/core/trajectory/git/rerank/derived-signals/recency.ts`:

```typescript
readonly inverted = true as const;
```

In `src/core/trajectory/git/rerank/derived-signals/stability.ts`:

```typescript
readonly inverted = true as const;
```

In `src/core/trajectory/git/rerank/derived-signals/block-penalty.ts`:

```typescript
readonly inverted = true as const;
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/contracts/types/inverted-signals.test.ts`
Expected: PASS — all 6 tests green

**Step 5: Commit**

```
feat(contracts): add inverted field to DerivedSignalDescriptor
```

---

### Task 2: Add `scrollOrderedBy` to Qdrant scroll adapter

**Files:**

- Modify: `src/core/adapters/qdrant/scroll.ts`
- Test: `tests/core/adapters/qdrant/scroll-ordered.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, expect, it, vi } from "vitest";

import { scrollOrderedBy } from "../../../../src/core/adapters/qdrant/scroll.js";

function createMockQdrant(scrollResponse: unknown) {
  return {
    client: {
      scroll: vi.fn().mockResolvedValue(scrollResponse),
    },
  };
}

describe("scrollOrderedBy", () => {
  it("calls scroll with order_by, filter, and limit", async () => {
    const mockResponse = {
      points: [
        { id: "a", payload: { methodLines: 200, relativePath: "big.ts" } },
        { id: "b", payload: { methodLines: 150, relativePath: "medium.ts" } },
      ],
      next_page_offset: null,
    };
    const qdrant = createMockQdrant(mockResponse);

    const results = await scrollOrderedBy(
      qdrant as never,
      "test-collection",
      { key: "methodLines", direction: "desc" },
      10,
    );

    expect(qdrant.client.scroll).toHaveBeenCalledWith("test-collection", {
      limit: 10,
      offset: undefined,
      with_payload: true,
      with_vector: false,
      order_by: { key: "methodLines", direction: "desc" },
    });
    expect(results).toHaveLength(2);
    expect(results[0].id).toBe("a");
    expect(results[0].payload.methodLines).toBe(200);
  });

  it("passes filter when provided", async () => {
    const qdrant = createMockQdrant({ points: [], next_page_offset: null });

    await scrollOrderedBy(
      qdrant as never,
      "test-collection",
      { key: "git.file.ageDays", direction: "asc" },
      5,
      { must: [{ key: "language", match: { value: "typescript" } }] },
    );

    expect(qdrant.client.scroll).toHaveBeenCalledWith(
      "test-collection",
      expect.objectContaining({
        filter: { must: [{ key: "language", match: { value: "typescript" } }] },
      }),
    );
  });

  it("returns empty array when no points match", async () => {
    const qdrant = createMockQdrant({ points: [], next_page_offset: null });

    const results = await scrollOrderedBy(
      qdrant as never,
      "test-collection",
      { key: "methodLines", direction: "desc" },
      10,
    );

    expect(results).toEqual([]);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/adapters/qdrant/scroll-ordered.test.ts`
Expected: FAIL — `scrollOrderedBy` not exported

**Step 3: Write minimal implementation**

Add to `src/core/adapters/qdrant/scroll.ts`:

```typescript
interface OrderBy {
  key: string;
  direction: "asc" | "desc";
}

interface OrderedScrollResult {
  points: { id: string | number; payload?: Record<string, unknown> | null }[];
  next_page_offset?: string | number | null;
}

interface OrderedScrollClient {
  client: {
    scroll: (
      collectionName: string,
      options: {
        limit: number;
        offset: string | number | undefined;
        with_payload: boolean;
        with_vector: boolean;
        order_by?: OrderBy;
        filter?: Record<string, unknown>;
      },
    ) => Promise<OrderedScrollResult>;
  };
}

/** Scroll points ordered by a payload field. Returns points with IDs and payloads. */
export async function scrollOrderedBy(
  qdrant: QdrantManager,
  collectionName: string,
  orderBy: OrderBy,
  limit: number,
  filter?: Record<string, unknown>,
): Promise<{ id: string | number; payload: Record<string, unknown> }[]> {
  const result = await (qdrant as unknown as OrderedScrollClient).client.scroll(
    collectionName,
    {
      limit,
      offset: undefined,
      with_payload: true,
      with_vector: false,
      order_by: orderBy,
      ...(filter ? { filter } : {}),
    },
  );

  return result.points
    .filter(
      (p): p is { id: string | number; payload: Record<string, unknown> } =>
        p.payload != null,
    )
    .map((p) => ({ id: p.id, payload: p.payload! }));
}
```

Note: single-page scroll (no pagination) — we only need top-N, not all points.
The `limit` parameter controls how many we fetch.

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/adapters/qdrant/scroll-ordered.test.ts`
Expected: PASS

**Step 5: Commit**

```
feat(qdrant): add scrollOrderedBy for ordered payload scroll
```

---

### Task 3: Add `rank_chunks` to preset tools lists

**Files:**

- Modify: All preset files in `src/core/trajectory/static/rerank/presets/` and
  `src/core/trajectory/git/rerank/presets/`
- Test: `tests/core/trajectory/presets-rank-chunks.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";

import { GIT_PRESETS } from "../../../../src/core/trajectory/git/rerank/presets/index.js";
import { STATIC_PRESETS } from "../../../../src/core/trajectory/static/rerank/presets/index.js";

describe("rank_chunks preset support", () => {
  const allPresets = [...STATIC_PRESETS, ...GIT_PRESETS];

  it("all presets include rank_chunks in tools", () => {
    for (const preset of allPresets) {
      expect(
        preset.tools,
        `${preset.name} should include rank_chunks`,
      ).toContain("rank_chunks");
    }
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/trajectory/presets-rank-chunks.test.ts`
Expected: FAIL — no preset has `rank_chunks` in tools

**Step 3: Add `"rank_chunks"` to every preset's `tools` array**

In each preset file, add `"rank_chunks"` to the `tools` array:

- `src/core/trajectory/static/rerank/presets/relevance.ts`:
  `["semantic_search", "search_code", "rank_chunks"]`
- `src/core/trajectory/static/rerank/presets/decomposition.ts`:
  `["semantic_search", "search_code", "rank_chunks"]`
- `src/core/trajectory/git/rerank/presets/tech-debt.ts`:
  `["semantic_search", "rank_chunks"]`
- `src/core/trajectory/git/rerank/presets/hotspots.ts`:
  `["semantic_search", "rank_chunks"]`
- `src/core/trajectory/git/rerank/presets/code-review.ts`:
  `["semantic_search", "rank_chunks"]`
- `src/core/trajectory/git/rerank/presets/onboarding.ts`:
  `["semantic_search", "rank_chunks"]`
- `src/core/trajectory/git/rerank/presets/security-audit.ts`:
  `["semantic_search", "rank_chunks"]`
- `src/core/trajectory/git/rerank/presets/refactoring.ts`:
  `["semantic_search", "rank_chunks"]`
- `src/core/trajectory/git/rerank/presets/ownership.ts`:
  `["semantic_search", "rank_chunks"]`
- `src/core/trajectory/git/rerank/presets/recent.ts`:
  `["search_code", "semantic_search", "rank_chunks"]`
- `src/core/trajectory/git/rerank/presets/stable.ts`:
  `["search_code", "semantic_search", "rank_chunks"]`

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/trajectory/presets-rank-chunks.test.ts`
Expected: PASS

**Step 5: Commit**

```
feat(presets): add rank_chunks to all preset tool lists
```

---

### Task 4: Implement `RankModule` — scatter-gather orchestration

**Files:**

- Create: `src/core/search/rank-module.ts`
- Test: `tests/core/search/rank-module.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, expect, it, vi } from "vitest";

import type { DerivedSignalDescriptor } from "../../../src/core/contracts/types/reranker.js";
import { RankModule } from "../../../src/core/search/rank-module.js";
import type { Reranker } from "../../../src/core/search/reranker.js";

// Minimal descriptors for testing
const chunkSizeDesc: DerivedSignalDescriptor = {
  name: "chunkSize",
  description: "size",
  sources: ["methodLines"],
  defaultBound: 500,
  extract: (raw) => {
    const v = (raw.methodLines as number) || 0;
    return Math.min(1, v / 500);
  },
};

const churnDesc: DerivedSignalDescriptor = {
  name: "churn",
  description: "churn",
  sources: ["file.commitCount", "chunk.commitCount"],
  defaultBound: 50,
  extract: (raw) => {
    const git = raw.git as Record<string, Record<string, number>> | undefined;
    return Math.min(1, (git?.file?.commitCount ?? 0) / 50);
  },
};

const recencyDesc: DerivedSignalDescriptor = {
  name: "recency",
  description: "recency",
  sources: ["file.ageDays", "chunk.ageDays"],
  defaultBound: 365,
  inverted: true,
  extract: (raw) => {
    const git = raw.git as Record<string, Record<string, number>> | undefined;
    return 1 - Math.min(1, (git?.file?.ageDays ?? 0) / 365);
  },
};

function createMockScrollFn(
  data: Map<
    string,
    { id: string | number; payload: Record<string, unknown> }[]
  >,
) {
  return vi
    .fn()
    .mockImplementation((_col: string, orderBy: { key: string }) => {
      return Promise.resolve(data.get(orderBy.key) ?? []);
    });
}

function createMockReranker(): Reranker {
  return {
    rerank: vi.fn().mockImplementation((results: { score: number }[]) => {
      // Pass through with score preserved
      return results.map((r) => ({ ...r, rankingOverlay: { preset: "test" } }));
    }),
    getPreset: vi.fn(),
    getAvailablePresets: vi.fn().mockReturnValue(["decomposition"]),
    resolvedPresets: [],
  } as unknown as Reranker;
}

describe("RankModule", () => {
  describe("resolveOrderByFields", () => {
    it("resolves chunk-level fields from sources and inverted flag", () => {
      const module = new RankModule(null as never, createMockReranker(), [
        chunkSizeDesc,
        churnDesc,
        recencyDesc,
      ]);

      const fields = module.resolveOrderByFields(
        { chunkSize: 0.5, churn: 0.3, recency: 0.2 },
        "chunk",
      );

      expect(fields).toEqual([
        { key: "methodLines", direction: "desc" },
        { key: "git.chunk.commitCount", direction: "desc" },
        { key: "git.chunk.ageDays", direction: "asc" }, // inverted
      ]);
    });

    it("resolves file-level fields when level=file", () => {
      const module = new RankModule(null as never, createMockReranker(), [
        churnDesc,
      ]);

      const fields = module.resolveOrderByFields({ churn: 1.0 }, "file");

      expect(fields).toEqual([
        { key: "git.file.commitCount", direction: "desc" },
      ]);
    });

    it("skips similarity weight", () => {
      const module = new RankModule(null as never, createMockReranker(), [
        chunkSizeDesc,
      ]);

      const fields = module.resolveOrderByFields(
        { similarity: 0.5, chunkSize: 0.5 },
        "chunk",
      );

      expect(fields).toHaveLength(1);
      expect(fields[0].key).toBe("methodLines");
    });

    it("skips descriptors without matching level source", () => {
      // chunkSizeDesc has sources: ["methodLines"] — no file/chunk prefix, works for both
      const module = new RankModule(null as never, createMockReranker(), [
        chunkSizeDesc,
      ]);
      const fields = module.resolveOrderByFields({ chunkSize: 1.0 }, "chunk");
      expect(fields).toHaveLength(1);
    });
  });

  describe("rankChunks", () => {
    it("performs scatter-gather and returns merged results", async () => {
      const scrollData = new Map([
        [
          "methodLines",
          [
            { id: "a", payload: { methodLines: 200, relativePath: "big.ts" } },
            {
              id: "b",
              payload: { methodLines: 100, relativePath: "medium.ts" },
            },
          ],
        ],
      ]);

      const mockScroll = createMockScrollFn(scrollData);
      const mockReranker = createMockReranker();
      const module = new RankModule(null as never, mockReranker, [
        chunkSizeDesc,
      ]);

      const results = await module.rankChunks("test-col", {
        weights: { chunkSize: 1.0 },
        level: "chunk",
        limit: 10,
        scrollFn: mockScroll,
      });

      expect(mockScroll).toHaveBeenCalledTimes(1);
      expect(mockReranker.rerank).toHaveBeenCalledTimes(1);
      expect(results).toHaveLength(2);
    });

    it("deduplicates points from multiple scrolls", async () => {
      const scrollData = new Map([
        [
          "methodLines",
          [
            { id: "a", payload: { methodLines: 200 } },
            { id: "b", payload: { methodLines: 100 } },
          ],
        ],
        [
          "git.chunk.commitCount",
          [
            { id: "b", payload: { methodLines: 100 } }, // duplicate
            { id: "c", payload: { methodLines: 50 } },
          ],
        ],
      ]);

      const mockScroll = createMockScrollFn(scrollData);
      const mockReranker = createMockReranker();
      const module = new RankModule(null as never, mockReranker, [
        chunkSizeDesc,
        churnDesc,
      ]);

      const results = await module.rankChunks("test-col", {
        weights: { chunkSize: 0.5, churn: 0.5 },
        level: "chunk",
        limit: 10,
        scrollFn: mockScroll,
      });

      // a, b, c — b deduplicated
      const rerankedInput = (mockReranker.rerank as ReturnType<typeof vi.fn>)
        .mock.calls[0][0];
      expect(rerankedInput).toHaveLength(3);
    });

    it("removes similarity from weights and re-normalizes", async () => {
      const scrollData = new Map([
        ["methodLines", [{ id: "a", payload: { methodLines: 200 } }]],
      ]);

      const mockScroll = createMockScrollFn(scrollData);
      const mockReranker = createMockReranker();
      const module = new RankModule(null as never, mockReranker, [
        chunkSizeDesc,
      ]);

      await module.rankChunks("test-col", {
        weights: { similarity: 0.5, chunkSize: 0.5 },
        level: "chunk",
        limit: 10,
        scrollFn: mockScroll,
      });

      // Reranker should receive weights without similarity
      const rerankerCall = (mockReranker.rerank as ReturnType<typeof vi.fn>)
        .mock.calls[0];
      const mode = rerankerCall[1];
      expect(mode.custom.similarity).toBeUndefined();
      expect(mode.custom.chunkSize).toBeCloseTo(1.0);
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/search/rank-module.test.ts` Expected: FAIL —
`RankModule` not found

**Step 3: Write minimal implementation**

Create `src/core/search/rank-module.ts`:

```typescript
/**
 * RankModule — scroll-based chunk ranking without vector search.
 *
 * Scatter-gather: resolve order_by fields from preset weights → parallel scroll → merge → rerank.
 */

import type {
  DerivedSignalDescriptor,
  RerankableResult,
} from "../contracts/types/reranker.js";
import type { Reranker } from "./reranker.js";

interface OrderByField {
  key: string;
  direction: "asc" | "desc";
}

type ScrollFn = (
  collectionName: string,
  orderBy: OrderByField,
  limit: number,
  filter?: Record<string, unknown>,
) => Promise<{ id: string | number; payload: Record<string, unknown> }[]>;

export interface RankOptions {
  weights: Record<string, number>;
  level: "chunk" | "file";
  limit: number;
  scrollFn: ScrollFn;
  filter?: Record<string, unknown>;
  pathPattern?: string;
}

const OVERFETCH_FACTOR = 3;

export class RankModule {
  private readonly descriptorMap: Map<string, DerivedSignalDescriptor>;

  constructor(
    _qdrant: unknown,
    private readonly reranker: Reranker,
    private readonly descriptors: DerivedSignalDescriptor[],
  ) {
    this.descriptorMap = new Map();
    for (const d of descriptors) {
      this.descriptorMap.set(d.name, d);
    }
  }

  /**
   * Resolve order_by fields from preset weights + descriptor sources + inverted flag.
   */
  resolveOrderByFields(
    weights: Record<string, number>,
    level: "chunk" | "file",
  ): OrderByField[] {
    const fields: OrderByField[] = [];

    for (const [key, weight] of Object.entries(weights)) {
      if (key === "similarity" || !weight) continue;

      const desc = this.descriptorMap.get(key);
      if (!desc) continue;

      const payloadField = this.resolvePayloadField(desc.sources, level);
      if (!payloadField) continue;

      fields.push({
        key: payloadField,
        direction: desc.inverted ? "asc" : "desc",
      });
    }

    return fields;
  }

  /**
   * Rank chunks: scatter-gather → merge → rerank → top-N.
   */
  async rankChunks(
    collectionName: string,
    options: RankOptions,
  ): Promise<RerankableResult[]> {
    const { weights, level, limit, scrollFn, filter } = options;

    // Remove similarity and re-normalize
    const cleanWeights = this.removeAndNormalize(weights);

    // Resolve order_by fields
    const orderByFields = this.resolveOrderByFields(cleanWeights, level);
    if (orderByFields.length === 0) return [];

    // Parallel scroll (scatter)
    const fetchLimit = limit * OVERFETCH_FACTOR;
    const scrollResults = await Promise.all(
      orderByFields.map((field) =>
        scrollFn(collectionName, field, fetchLimit, filter),
      ),
    );

    // Merge + deduplicate (gather)
    const merged = this.mergeAndDeduplicate(scrollResults);
    if (merged.length === 0) return [];

    // Convert to RerankableResult (score=0, no similarity)
    const rerankable: RerankableResult[] = merged.map((p) => ({
      score: 0,
      payload: p.payload,
    }));

    // Rerank with cleaned weights
    const reranked = this.reranker.rerank(
      rerankable,
      { custom: cleanWeights },
      "rank_chunks",
    );

    return reranked.slice(0, limit);
  }

  // -- Private --

  private resolvePayloadField(
    sources: string[],
    level: "chunk" | "file",
  ): string | undefined {
    // 1. Try level-prefixed source (e.g. "chunk.commitCount" → "git.chunk.commitCount")
    const levelSource = sources.find((s) => s.startsWith(`${level}.`));
    if (levelSource) return `git.${levelSource}`;

    // 2. Try unprefixed source (e.g. "methodLines")
    const unprefixed = sources.find((s) => !s.includes("."));
    if (unprefixed) return unprefixed;

    // 3. Fallback: first source with git prefix
    return sources[0] ? `git.${sources[0]}` : undefined;
  }

  private removeAndNormalize(
    weights: Record<string, number>,
  ): Record<string, number> {
    const clean: Record<string, number> = {};
    let total = 0;

    for (const [key, weight] of Object.entries(weights)) {
      if (key === "similarity" || !weight) continue;
      clean[key] = weight;
      total += weight;
    }

    if (total === 0) return clean;

    for (const key of Object.keys(clean)) {
      clean[key] = clean[key] / total;
    }

    return clean;
  }

  private mergeAndDeduplicate(
    scrollResults: {
      id: string | number;
      payload: Record<string, unknown>;
    }[][],
  ): { id: string | number; payload: Record<string, unknown> }[] {
    const seen = new Map<
      string | number,
      { id: string | number; payload: Record<string, unknown> }
    >();

    for (const results of scrollResults) {
      for (const point of results) {
        if (!seen.has(point.id)) {
          seen.set(point.id, point);
        }
      }
    }

    return [...seen.values()];
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/search/rank-module.test.ts` Expected: PASS

**Step 5: Commit**

```
feat(search): add RankModule for scroll-based chunk ranking
```

---

### Task 5: Register `rank_chunks` MCP tool

**Files:**

- Modify: `src/mcp/tools/schemas.ts`
- Modify: `src/mcp/tools/search.ts`
- Modify: `src/mcp/tools/index.ts` (if deps wiring needed)
- Test: `tests/mcp/tools/rank-chunks.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, expect, it, vi } from "vitest";

// Test that the schema is created correctly
import { createSearchSchemas } from "../../../src/mcp/tools/schemas.js";

describe("rank_chunks schema", () => {
  it("createSearchSchemas returns RankChunksSchema", () => {
    const mockSchemaBuilder = {
      buildRerankSchema: vi.fn().mockReturnValue({
        optional: () => ({ describe: () => ({}) }),
      }),
    };
    const schemas = createSearchSchemas(mockSchemaBuilder as never);
    expect(schemas).toHaveProperty("RankChunksSchema");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mcp/tools/rank-chunks.test.ts` Expected: FAIL —
`RankChunksSchema` not in return

**Step 3: Implement schema and tool registration**

In `src/mcp/tools/schemas.ts`, add to `createSearchSchemas`:

```typescript
const RankChunksSchema = {
  ...collectionPathFields(),
  rerank: semanticSearchRerankSchema.describe(
    "Reranking mode (REQUIRED). Determines how chunks are scored and sorted. " +
      "Enum: 'decomposition' | 'techDebt' | 'hotspots' | 'codeReview' | " +
      "'refactoring' | 'ownership' | 'recent' | 'stable' | {custom: weights}. " +
      "similarity weight is ignored (no vector search).",
  ),
  level: z
    .enum(["chunk", "file"])
    .describe(
      "Analysis level. 'chunk' for active work (decomposition, hotspots). " +
        "'file' for tech debt and ownership analysis.",
    ),
  limit: coerceNumber()
    .optional()
    .describe("Maximum number of results (default: 10)"),
  filter: z
    .record(z.any())
    .optional()
    .describe("Qdrant filter object with must/should/must_not conditions."),
  pathPattern: z
    .string()
    .optional()
    .describe(
      "Glob pattern for filtering by file path (picomatch). Examples: 'src/**/*.ts'",
    ),
  metaOnly: coerceBoolean()
    .optional()
    .describe("Return only metadata without content. Default: false."),
};
```

Update return:
`return { SemanticSearchSchema, HybridSearchSchema, SearchCodeSchema, RankChunksSchema };`

In `src/mcp/tools/search.ts`, add `rank_chunks` registration:

```typescript
import { filterResultsByGlob } from "../../core/adapters/qdrant/filters/index.js";
import { scrollOrderedBy } from "../../core/adapters/qdrant/scroll.js";
import { RankModule } from "../../core/search/rank-module.js";
```

Inside `registerSearchTools`, after hybrid_search registration:

```typescript
// rank_chunks
const rankModule = new RankModule(
  qdrant,
  deps.reranker /* descriptors from deps */,
);

server.registerTool(
  "rank_chunks",
  {
    title: "Rank Chunks",
    description:
      "Rank all chunks in a collection by rerank signals without vector search. " +
      "Use for: finding decomposition candidates, tech debt analysis, hotspot detection, " +
      "ownership reports — any analysis where you need top-N chunks by signal, not by query similarity.",
    inputSchema: searchSchemas.RankChunksSchema,
  },
  async ({
    collection,
    path,
    rerank,
    level,
    limit,
    filter,
    pathPattern,
    metaOnly,
  }) => {
    const resolved = resolveCollectionName(collection, path);
    if ("error" in resolved) return resolved.error;

    const collectionError = await validateCollectionExists(
      qdrant,
      resolved.collectionName,
      path,
    );
    if (collectionError) return collectionError;

    // Resolve weights from preset or custom
    let weights: Record<string, number>;
    if (typeof rerank === "string") {
      const preset = deps.reranker.getPreset(rerank, "rank_chunks");
      if (!preset) {
        return {
          content: [
            {
              type: "text",
              text: `Error: Unknown preset "${rerank}" for rank_chunks.`,
            },
          ],
          isError: true,
        };
      }
      weights = { ...preset };
    } else {
      weights = { ...rerank.custom };
    }

    const scrollFn = (
      col: string,
      orderBy: { key: string; direction: "asc" | "desc" },
      lim: number,
      f?: Record<string, unknown>,
    ) => scrollOrderedBy(qdrant, col, orderBy, lim, f);

    let results = await rankModule.rankChunks(resolved.collectionName, {
      weights,
      level,
      limit: limit || 10,
      scrollFn,
      filter,
    });

    // Apply pathPattern client-side
    if (pathPattern) {
      results = filterResultsByGlob(
        results as never,
        pathPattern,
      ) as typeof results;
    }

    const result = formatSearchResults(
      results as never,
      metaOnly,
      deps.essentialTrajectoryFields,
    );
    const driftWarning = path
      ? await schemaDriftMonitor.checkAndConsume(path)
      : schemaDriftMonitor.checkByCollectionName(resolved.collectionName);
    return appendDriftWarning(result, driftWarning);
  },
);
```

Note: `RankModule` needs descriptors passed from deps. Add
`descriptors: DerivedSignalDescriptor[]` to `SearchToolDependencies` interface.
Wire in `src/mcp/tools/index.ts` where dependencies are assembled.

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/mcp/tools/rank-chunks.test.ts` Expected: PASS

**Step 5: Commit**

```
feat(mcp): register rank_chunks tool with schema and handler
```

---

### Task 6: Integration test — end-to-end rank_chunks

**Files:**

- Test: `tests/core/search/rank-module-integration.test.ts`

**Step 1: Write integration test**

```typescript
import { describe, expect, it, vi } from "vitest";

import { RankModule } from "../../../src/core/search/rank-module.js";
import { Reranker } from "../../../src/core/search/reranker.js";
import { ChurnSignal } from "../../../src/core/trajectory/git/rerank/derived-signals/churn.js";
import { RecencySignal } from "../../../src/core/trajectory/git/rerank/derived-signals/recency.js";
import { ChunkDensitySignal } from "../../../src/core/trajectory/static/rerank/derived-signals/chunk-density.js";
import { ChunkSizeSignal } from "../../../src/core/trajectory/static/rerank/derived-signals/chunk-size.js";
import { SimilaritySignal } from "../../../src/core/trajectory/static/rerank/derived-signals/similarity.js";

describe("RankModule integration", () => {
  const descriptors = [
    new SimilaritySignal(),
    new ChunkSizeSignal(),
    new ChunkDensitySignal(),
    new RecencySignal(),
    new ChurnSignal(),
  ];

  const presets = [
    {
      name: "decomposition",
      description: "test",
      tools: ["rank_chunks"],
      weights: { chunkSize: 0.6, chunkDensity: 0.3, similarity: 0.1 },
      overlayMask: { derived: ["chunkSize", "chunkDensity"] },
    },
  ];

  it("ranks chunks by chunkSize with decomposition preset", async () => {
    const reranker = new Reranker(descriptors, presets);
    const module = new RankModule(null, reranker, descriptors);

    const mockScroll = vi
      .fn()
      .mockImplementation((_col: string, orderBy: { key: string }) => {
        if (orderBy.key === "methodLines") {
          return Promise.resolve([
            {
              id: "big",
              payload: {
                methodLines: 200,
                methodDensity: 40,
                relativePath: "big.ts",
              },
            },
            {
              id: "small",
              payload: {
                methodLines: 20,
                methodDensity: 60,
                relativePath: "small.ts",
              },
            },
            {
              id: "medium",
              payload: {
                methodLines: 80,
                methodDensity: 30,
                relativePath: "medium.ts",
              },
            },
          ]);
        }
        if (orderBy.key === "methodDensity") {
          return Promise.resolve([
            {
              id: "small",
              payload: {
                methodLines: 20,
                methodDensity: 60,
                relativePath: "small.ts",
              },
            },
            {
              id: "big",
              payload: {
                methodLines: 200,
                methodDensity: 40,
                relativePath: "big.ts",
              },
            },
          ]);
        }
        return Promise.resolve([]);
      });

    const results = await module.rankChunks("test-col", {
      weights: { chunkSize: 0.6, chunkDensity: 0.3, similarity: 0.1 },
      level: "chunk",
      limit: 3,
      scrollFn: mockScroll,
    });

    // big.ts should rank highest (200 lines)
    expect(results.length).toBeGreaterThan(0);
    expect((results[0].payload as Record<string, unknown>)?.relativePath).toBe(
      "big.ts",
    );

    // Verify deduplication: "small" appears in both scrolls but only once in results
    expect(mockScroll).toHaveBeenCalledTimes(2); // methodLines + methodDensity
  });
});
```

**Step 2: Run test**

Run: `npx vitest run tests/core/search/rank-module-integration.test.ts`
Expected: PASS

**Step 3: Commit**

```
test(search): add integration test for rank_chunks scatter-gather
```

---

### Task 7: Wire dependencies and verify build

**Files:**

- Modify: `src/mcp/tools/index.ts` (add descriptors to SearchToolDependencies)
- Modify: wherever SearchToolDependencies is assembled (check factory/bootstrap)

**Step 1: Build and type-check**

Run: `npm run build && npm run type-check` Expected: PASS — no type errors

**Step 2: Run full test suite**

Run: `npx vitest run` Expected: All tests pass, including new ones

**Step 3: Commit**

```
chore(mcp): wire rank_chunks dependencies in tool registration
```

---

## Task Dependency Graph

```
Task 1 (inverted field)
  ↓
Task 2 (scrollOrderedBy)      ← independent of Task 1
  ↓
Task 3 (preset tools lists)   ← independent of Task 1, 2
  ↓
Task 4 (RankModule)            ← depends on Task 1 + Task 2
  ↓
Task 5 (MCP tool)              ← depends on Task 4 + Task 3
  ↓
Task 6 (integration test)      ← depends on Task 4
  ↓
Task 7 (wiring + build)        ← depends on Task 5
```

Tasks 1, 2, 3 can run in parallel. Task 4 depends on 1+2. Task 5 depends on 3+4.
