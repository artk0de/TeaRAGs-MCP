# get_index_metrics + Overlay Labels — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development
> (if subagents available) or superpowers:executing-plans to implement this
> plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `get_index_metrics` MCP tool with percentile-based thresholds, and
human-readable labels to ranking overlay — so LLM agents can pick filter values
and interpret search results without guessing.

**Architecture:** Signal descriptors declare `stats.labels` (e.g.
`{ p25: "low", p75: "high" }`) instead of `stats.percentiles`. Reranker
auto-resolves labels for overlay values using cached percentiles. New
`get_index_metrics` exposes stats + distributions + `labelMap` per signal.

**Tech Stack:** TypeScript, Vitest, Qdrant, existing DI/facade/trajectory
system.

**Spec:**
`docs/superpowers/specs/2026-03-16-index-metrics-overlay-labels-design.md`

---

## Chunk 1: Contracts + Signal Descriptors

### Task 1: Replace `percentiles` with `labels` in SignalStatsRequest

**Files:**

- Modify: `src/core/contracts/types/trajectory.ts:9-16`
- Test: `tests/core/contracts/signal-stats-request.test.ts` (new)

- [ ] **Step 1: Write test for new SignalStatsRequest shape**

```typescript
// tests/core/contracts/signal-stats-request.test.ts
import { describe, expect, it } from "vitest";

import type { SignalStatsRequest } from "../../../src/core/contracts/types/trajectory.js";

describe("SignalStatsRequest", () => {
  it("should accept labels record with pNN keys", () => {
    const req: SignalStatsRequest = {
      labels: { p25: "low", p50: "typical", p75: "high", p95: "extreme" },
    };
    expect(req.labels).toBeDefined();
    expect(Object.keys(req.labels!)).toEqual(["p25", "p50", "p75", "p95"]);
  });

  it("should not have percentiles field", () => {
    const req: SignalStatsRequest = { labels: { p50: "normal" } };
    expect(req).not.toHaveProperty("percentiles");
  });

  it("should still accept mean and stddev", () => {
    const req: SignalStatsRequest = {
      labels: { p95: "extreme" },
      mean: true,
      stddev: true,
    };
    expect(req.mean).toBe(true);
    expect(req.stddev).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/contracts/signal-stats-request.test.ts`
Expected: FAIL — `percentiles` still exists on the type, type check passes but
the "should not have percentiles" test won't compile cleanly since the field
exists.

- [ ] **Step 3: Modify SignalStatsRequest**

In `src/core/contracts/types/trajectory.ts:9-16`, replace:

```typescript
export interface SignalStatsRequest {
  /** Which percentiles to compute (e.g. [25, 50, 75, 95]) */
  percentiles?: number[];
  /** Compute arithmetic mean */
  mean?: boolean;
  /** Compute standard deviation */
  stddev?: boolean;
}
```

With:

```typescript
export interface SignalStatsRequest {
  /**
   * Percentile-to-label mapping. Keys are pNN (e.g. p25, p50, p75, p95).
   * Percentiles to collect are derived from keys.
   * Labels are used in ranking overlay and get_index_metrics labelMap.
   */
  labels?: Record<string, string>;
  /** Compute arithmetic mean */
  mean?: boolean;
  /** Compute standard deviation */
  stddev?: boolean;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/contracts/signal-stats-request.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/core/contracts/types/trajectory.ts tests/core/contracts/signal-stats-request.test.ts
git commit -m "refactor(contracts): replace percentiles with labels in SignalStatsRequest"
```

---

### Task 2: Add min/max to SignalStats, add Distributions to CollectionSignalStats

**Files:**

- Modify: `src/core/contracts/types/trajectory.ts:33-45`
- Test: `tests/core/contracts/signal-stats-request.test.ts` (extend)

- [ ] **Step 1: Write tests for new SignalStats and Distributions shapes**

Append to `tests/core/contracts/signal-stats-request.test.ts`:

```typescript
import type {
  CollectionSignalStats,
  Distributions,
  SignalStats,
} from "../../../src/core/contracts/types/trajectory.js";

describe("SignalStats", () => {
  it("should require min, max, percentiles", () => {
    const stats: SignalStats = {
      count: 100,
      min: 1,
      max: 50,
      percentiles: { 25: 3, 50: 8, 75: 15, 95: 42 },
    };
    expect(stats.min).toBe(1);
    expect(stats.max).toBe(50);
    expect(stats.percentiles[95]).toBe(42);
  });
});

describe("Distributions", () => {
  it("should have all required fields", () => {
    const dist: Distributions = {
      totalFiles: 100,
      language: { typescript: 80, python: 20 },
      chunkType: { function: 60, class: 30, block: 10 },
      documentation: { docs: 15, code: 85 },
      topAuthors: [{ name: "Alice", chunks: 50 }],
      othersCount: 50,
    };
    expect(dist.totalFiles).toBe(100);
    expect(dist.topAuthors[0].name).toBe("Alice");
  });
});

describe("CollectionSignalStats", () => {
  it("should include distributions", () => {
    const stats: CollectionSignalStats = {
      perSignal: new Map(),
      distributions: {
        totalFiles: 0,
        language: {},
        chunkType: {},
        documentation: { docs: 0, code: 0 },
        topAuthors: [],
        othersCount: 0,
      },
      computedAt: Date.now(),
    };
    expect(stats.distributions).toBeDefined();
    expect(stats.distributions.totalFiles).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/contracts/signal-stats-request.test.ts`
Expected: FAIL — `min`, `max` don't exist on SignalStats, `Distributions`
doesn't exist, `distributions` not on CollectionSignalStats.

- [ ] **Step 3: Update types**

In `src/core/contracts/types/trajectory.ts`, replace SignalStats (lines 33-39):

```typescript
/** Computed statistics for a single signal across the collection. */
export interface SignalStats {
  count: number;
  min: number;
  max: number;
  /** Keyed by percentile number: { 25: 4.2, 50: 8.1, 75: 15.3, 95: 42.0 } */
  percentiles: Record<number, number>;
  mean?: number;
  stddev?: number;
}
```

Add Distributions interface (before CollectionSignalStats):

```typescript
/** Aggregate distributions across collection chunks. */
export interface Distributions {
  totalFiles: number;
  language: Record<string, number>;
  chunkType: Record<string, number>;
  documentation: { docs: number; code: number };
  topAuthors: { name: string; chunks: number }[];
  othersCount: number;
}
```

Update CollectionSignalStats (lines 42-45):

```typescript
/** Collection-wide signal statistics, cached between reindexes. */
export interface CollectionSignalStats {
  perSignal: Map<string, SignalStats>;
  distributions: Distributions;
  computedAt: number;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/contracts/signal-stats-request.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/core/contracts/types/trajectory.ts tests/core/contracts/signal-stats-request.test.ts
git commit -m "refactor(contracts): add min/max to SignalStats, add Distributions"
```

---

### Task 3: Remove `derived` from OverlayMask and RankingOverlay

**Files:**

- Modify: `src/core/contracts/types/reranker.ts:48-52,73-78`
- Test: `tests/core/contracts/overlay-types.test.ts` (new)

- [ ] **Step 1: Write test**

```typescript
// tests/core/contracts/overlay-types.test.ts
import { describe, expect, it } from "vitest";

import type {
  OverlayMask,
  RankingOverlay,
} from "../../../src/core/contracts/types/reranker.js";

describe("OverlayMask", () => {
  it("should only have file and chunk fields", () => {
    const mask: OverlayMask = {
      file: ["commitCount", "ageDays"],
      chunk: ["commitCount"],
    };
    expect(mask).not.toHaveProperty("derived");
    expect(mask.file).toHaveLength(2);
  });
});

describe("RankingOverlay", () => {
  it("should not have derived field", () => {
    const overlay: RankingOverlay = {
      preset: "techDebt",
      file: { commitCount: { value: 12, label: "high" } },
    };
    expect(overlay).not.toHaveProperty("derived");
  });

  it("should support value+label objects in file/chunk", () => {
    const overlay: RankingOverlay = {
      preset: "test",
      file: {
        commitCount: { value: 12, label: "high" },
        dominantAuthor: "Alice",
      },
      chunk: { commitCount: { value: 8, label: "high" } },
    };
    expect((overlay.file!.commitCount as any).label).toBe("high");
    expect(overlay.file!.dominantAuthor).toBe("Alice");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/contracts/overlay-types.test.ts` Expected: FAIL
— `derived` still exists on both types.

- [ ] **Step 3: Remove derived from both types**

In `src/core/contracts/types/reranker.ts`, update OverlayMask (lines 48-52):

```typescript
/** Curates which raw signals appear in the ranking overlay for a preset. */
export interface OverlayMask {
  readonly file?: string[];
  readonly chunk?: string[];
}
```

Update RankingOverlay (lines 73-78):

```typescript
/** Ranking overlay attached to each reranked result — explains WHY it scored this way. */
export interface RankingOverlay {
  preset: string;
  file?: Record<string, unknown>;
  chunk?: Record<string, unknown>;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/contracts/overlay-types.test.ts` Expected: PASS
(3 tests)

- [ ] **Step 5: Fix compilation errors from removed `derived`**

The following files reference `derived` on OverlayMask or RankingOverlay. Fix
each:

- `src/core/domains/trajectory/git/rerank/presets/refactoring.ts` — remove
  `derived` from `overlayMask`. Keep `file` and `chunk` arrays.
- `src/core/domains/trajectory/static/rerank/presets/decomposition.ts` — remove
  `derived` from `overlayMask`. Add `file: ["methodLines"]` to replace lost
  chunk size info.
- `src/core/domains/explore/reranker.ts` — remove the derived overlay block in
  `buildOverlay()` (lines 377-387). Remove any references to `mask.derived`.
  Remove `derived` from the returned overlay object.

- [ ] **Step 6: Fix existing test for decomposition preset**

In `tests/core/domains/explore/reranker.test.ts`, find the test "decomposition
preset includes derived values in overlay" (~line 1088). This test asserts
`overlay.derived` has `chunkSize`/`chunkDensity`. Rewrite it to check
`overlay.file.methodLines` exists instead (since DecompositionPreset now has
`file: ["methodLines"]` in overlayMask).

- [ ] **Step 7: Run full test suite**

Run: `npx vitest run` Expected: PASS — fix any remaining tests that check for
`derived` in overlay output.

- [ ] **Step 8: Commit**

```bash
git add src/core/contracts/types/reranker.ts \
  src/core/domains/trajectory/git/rerank/presets/refactoring.ts \
  src/core/domains/trajectory/static/rerank/presets/decomposition.ts \
  src/core/domains/explore/reranker.ts \
  tests/
git commit -m "refactor(reranker): remove derived from OverlayMask and RankingOverlay"
```

---

### Task 4: Migrate signal descriptors from `percentiles` to `labels`

**Files:**

- Modify: `src/core/domains/trajectory/git/payload-signals.ts`
- Modify: `src/core/domains/trajectory/static/payload-signals.ts`
- Test: `tests/core/domains/trajectory/signal-labels.test.ts` (new)

- [ ] **Step 1: Write test validating label declarations**

```typescript
// tests/core/domains/trajectory/signal-labels.test.ts
import { describe, expect, it } from "vitest";

import { gitPayloadSignalDescriptors } from "../../../../src/core/domains/trajectory/git/payload-signals.js";
import { BASE_PAYLOAD_SIGNALS } from "../../../../src/core/domains/trajectory/static/payload-signals.js";

describe("Git signal labels", () => {
  const numericWithStats = gitPayloadSignalDescriptors.filter(
    (s) => s.type === "number" && s.stats,
  );

  it("all numeric signals with stats should have labels", () => {
    for (const signal of numericWithStats) {
      expect(
        signal.stats!.labels,
        `${signal.key} missing labels`,
      ).toBeDefined();
      expect(signal.stats).not.toHaveProperty("percentiles");
    }
  });

  it("labels keys should be pNN format", () => {
    for (const signal of numericWithStats) {
      for (const key of Object.keys(signal.stats!.labels!)) {
        expect(key).toMatch(/^p\d+$/);
      }
    }
  });

  it("git.file.commitCount should have quartile labels", () => {
    const s = gitPayloadSignalDescriptors.find(
      (d) => d.key === "git.file.commitCount",
    );
    expect(s!.stats!.labels).toEqual({
      p25: "low",
      p50: "typical",
      p75: "high",
      p95: "extreme",
    });
  });

  it("git.file.ageDays should have age labels", () => {
    const s = gitPayloadSignalDescriptors.find(
      (d) => d.key === "git.file.ageDays",
    );
    expect(s!.stats!.labels).toEqual({
      p25: "recent",
      p50: "typical",
      p75: "old",
      p95: "legacy",
    });
  });
});

describe("Static signal labels", () => {
  it("methodLines should have size labels", () => {
    const s = BASE_PAYLOAD_SIGNALS.find((d) => d.key === "methodLines");
    expect(s!.stats!.labels).toEqual({
      p50: "small",
      p75: "large",
      p95: "decomposition_candidate",
    });
  });

  it("methodDensity should have density labels", () => {
    const s = BASE_PAYLOAD_SIGNALS.find((d) => d.key === "methodDensity");
    expect(s!.stats!.labels).toEqual({
      p50: "sparse",
      p95: "dense",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/domains/trajectory/signal-labels.test.ts`
Expected: FAIL — signals still have `percentiles`, not `labels`.

- [ ] **Step 3: Migrate git signal descriptors**

In `src/core/domains/trajectory/git/payload-signals.ts`, replace all
`stats: { percentiles: [...] }` with `stats: { labels: {...} }` per the label
map table in the spec. Full mapping:

| Signal                          | Labels                                                              |
| ------------------------------- | ------------------------------------------------------------------- |
| `git.file.commitCount`          | `{ p25: "low", p50: "typical", p75: "high", p95: "extreme" }`       |
| `git.file.ageDays`              | `{ p25: "recent", p50: "typical", p75: "old", p95: "legacy" }`      |
| `git.file.dominantAuthorPct`    | `{ p25: "shared", p50: "mixed", p75: "concentrated", p95: "silo" }` |
| `git.file.relativeChurn`        | `{ p75: "normal", p95: "high" }`                                    |
| `git.file.recencyWeightedFreq`  | `{ p75: "normal", p95: "burst" }`                                   |
| `git.file.changeDensity`        | `{ p50: "calm", p75: "active", p95: "intense" }`                    |
| `git.file.churnVolatility`      | `{ p75: "stable", p95: "erratic" }`                                 |
| `git.file.bugFixRate`           | `{ p50: "healthy", p75: "concerning", p95: "critical" }`            |
| `git.file.contributorCount`     | `{ p50: "solo", p75: "team", p95: "crowd" }`                        |
| `git.chunk.churnRatio`          | `{ p75: "normal", p95: "concentrated" }`                            |
| `git.chunk.commitCount`         | `{ p25: "low", p50: "typical", p75: "high", p95: "extreme" }`       |
| `git.chunk.ageDays`             | `{ p25: "recent", p50: "typical", p75: "old", p95: "legacy" }`      |
| `git.chunk.contributorCount`    | `{ p50: "solo", p95: "crowd" }`                                     |
| `git.chunk.bugFixRate`          | `{ p50: "healthy", p75: "concerning", p95: "critical" }`            |
| `git.chunk.relativeChurn`       | `{ p75: "normal", p95: "high" }`                                    |
| `git.chunk.recencyWeightedFreq` | `{ p75: "normal", p95: "burst" }`                                   |
| `git.chunk.changeDensity`       | `{ p75: "active", p95: "intense" }`                                 |
| `git.chunk.churnVolatility`     | `{ p75: "stable", p95: "erratic" }`                                 |

- [ ] **Step 4: Migrate static signal descriptors**

In `src/core/domains/trajectory/static/payload-signals.ts`:

- `methodLines`: replace `stats: { percentiles: [50, 95] }` with
  `stats: { labels: { p50: "small", p75: "large", p95: "decomposition_candidate" } }`
- `methodDensity`: replace `stats: { percentiles: [95] }` with
  `stats: { labels: { p50: "sparse", p95: "dense" } }`

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/core/domains/trajectory/signal-labels.test.ts`
Expected: PASS

- [ ] **Step 6: Run full test suite**

Run: `npx vitest run` Expected: Some tests in `collection-stats.test.ts` or
`reranker.test.ts` may fail because they read `stats.percentiles`. Fix by
updating to read from `stats.labels` keys instead.

- [ ] **Step 7: Commit**

```bash
git add src/core/domains/trajectory/git/payload-signals.ts \
  src/core/domains/trajectory/static/payload-signals.ts \
  tests/core/domains/trajectory/signal-labels.test.ts \
  tests/
git commit -m "refactor(signals): migrate all descriptors from percentiles to labels"
```

---

## Chunk 2: Stats Computation + Cache

### Task 5: Update `computeCollectionStats()` — labels, min/max, distributions

**Files:**

- Modify: `src/core/domains/ingest/collection-stats.ts`
- Modify: `tests/core/domains/ingest/collection-stats.test.ts`

- [ ] **Step 1: Write tests for new computation behavior**

Add to or create `tests/core/domains/ingest/collection-stats.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import type { PayloadSignalDescriptor } from "../../../../src/core/contracts/types/trajectory.js";
import { computeCollectionStats } from "../../../../src/core/domains/ingest/collection-stats.js";

const testSignals: PayloadSignalDescriptor[] = [
  {
    key: "git.file.commitCount",
    type: "number",
    description: "test",
    stats: {
      labels: { p25: "low", p50: "typical", p75: "high", p95: "extreme" },
    },
  },
  {
    key: "language",
    type: "string",
    description: "test",
  },
];

function makePoints(values: number[]) {
  return values.map((v, i) => ({
    payload: {
      "git.file.commitCount": v,
      language: i % 2 === 0 ? "typescript" : "python",
      chunkType: "function",
      isDocumentation: i === 0,
      relativePath: `file${i % 3}.ts`,
      "git.file.dominantAuthor": i % 2 === 0 ? "Alice" : "Bob",
    },
  }));
}

describe("computeCollectionStats", () => {
  it("should derive percentiles from labels keys", () => {
    const points = makePoints([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const result = computeCollectionStats(points, testSignals);
    const stats = result.perSignal.get("git.file.commitCount")!;
    expect(stats.percentiles).toHaveProperty("25");
    expect(stats.percentiles).toHaveProperty("50");
    expect(stats.percentiles).toHaveProperty("75");
    expect(stats.percentiles).toHaveProperty("95");
  });

  it("should compute min and max", () => {
    const points = makePoints([3, 1, 7, 2, 10]);
    const result = computeCollectionStats(points, testSignals);
    const stats = result.perSignal.get("git.file.commitCount")!;
    expect(stats.min).toBe(1);
    expect(stats.max).toBe(10);
  });

  it("should compute distributions.language", () => {
    const points = makePoints([1, 2, 3, 4]);
    const result = computeCollectionStats(points, testSignals);
    expect(result.distributions.language).toEqual({
      typescript: 2,
      python: 2,
    });
  });

  it("should compute distributions.chunkType", () => {
    const points = makePoints([1, 2]);
    const result = computeCollectionStats(points, testSignals);
    expect(result.distributions.chunkType).toEqual({ function: 2 });
  });

  it("should compute distributions.documentation", () => {
    const points = makePoints([1, 2, 3]);
    const result = computeCollectionStats(points, testSignals);
    expect(result.distributions.documentation).toEqual({ docs: 1, code: 2 });
  });

  it("should compute distributions.totalFiles from distinct relativePath", () => {
    const points = makePoints([1, 2, 3, 4, 5, 6]);
    const result = computeCollectionStats(points, testSignals);
    // relativePath cycles: file0, file1, file2, file0, file1, file2
    expect(result.distributions.totalFiles).toBe(3);
  });

  it("should compute distributions.topAuthors", () => {
    const points = makePoints([1, 2, 3, 4]);
    const result = computeCollectionStats(points, testSignals);
    expect(result.distributions.topAuthors).toEqual([
      { name: "Alice", chunks: 2 },
      { name: "Bob", chunks: 2 },
    ]);
    expect(result.distributions.othersCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/domains/ingest/collection-stats.test.ts`
Expected: FAIL — `computeCollectionStats` doesn't compute distributions,
min/max, or derive percentiles from labels.

- [ ] **Step 3: Implement updated computeCollectionStats**

In `src/core/domains/ingest/collection-stats.ts`:

1. Helper to extract percentiles from labels:

   ```typescript
   function percentilesFromLabels(labels: Record<string, string>): number[] {
     return Object.keys(labels)
       .map((k) => Number(k.slice(1)))
       .sort((a, b) => a - b);
   }
   ```

2. Update main function:
   - Filter signals with `stats?.labels` (not `stats?.percentiles`)
   - Track `min`/`max` per signal alongside values array
   - Aggregate distributions: `language`, `chunkType`, `isDocumentation`,
     `relativePath` (Set for distinct count), `git.file.dominantAuthor` (Map for
     counts)
   - After scroll: build top-10 authors, othersCount
   - Return `{ perSignal, distributions, computedAt }`

3. `SignalStats` now returns `min`, `max`, `percentiles` (required).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/domains/ingest/collection-stats.test.ts`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run` Expected: PASS (fix any callers that construct
`CollectionSignalStats` without `distributions`).

- [ ] **Step 6: Commit**

```bash
git add src/core/domains/ingest/collection-stats.ts \
  tests/core/domains/ingest/collection-stats.test.ts
git commit -m "feat(ingest): extend computeCollectionStats with labels, min/max, distributions"
```

---

### Task 6: Update StatsCache to version 3

**Files:**

- Modify: `src/core/infra/stats-cache.ts`
- Modify: `tests/core/infra/stats-cache.test.ts` (if exists, else create)

- [ ] **Step 1: Write test for v3 save/load with distributions**

```typescript
// tests/core/infra/stats-cache-v3.test.ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CollectionSignalStats } from "../../../src/core/contracts/types/trajectory.js";
import { StatsCache } from "../../../src/core/infra/stats-cache.js";

describe("StatsCache v3", () => {
  let cache: StatsCache;
  let tempDir: string;

  const testStats: CollectionSignalStats = {
    perSignal: new Map([
      [
        "git.file.commitCount",
        {
          count: 100,
          min: 1,
          max: 50,
          percentiles: { 25: 3, 50: 8, 75: 15, 95: 42 },
        },
      ],
    ]),
    distributions: {
      totalFiles: 10,
      language: { typescript: 80, python: 20 },
      chunkType: { function: 60, block: 40 },
      documentation: { docs: 15, code: 85 },
      topAuthors: [{ name: "Alice", chunks: 60 }],
      othersCount: 40,
    },
    computedAt: Date.now(),
  };

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "stats-cache-"));
    cache = new StatsCache(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("should save and load v3 with distributions", () => {
    cache.save("test_coll", testStats);
    const loaded = cache.load("test_coll");
    expect(loaded).not.toBeNull();
    expect(loaded!.distributions.totalFiles).toBe(10);
    expect(loaded!.distributions.language).toEqual({
      typescript: 80,
      python: 20,
    });
    expect(loaded!.perSignal.get("git.file.commitCount")!.min).toBe(1);
    expect(loaded!.perSignal.get("git.file.commitCount")!.max).toBe(50);
  });

  it("should reject v2 cache files", () => {
    // Save a v2-style file manually
    const fs = require("node:fs");
    const filePath = join(tempDir, "old_coll.stats.json");
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 2,
        collectionName: "old_coll",
        computedAt: Date.now(),
        perSignal: {},
      }),
    );

    const loaded = cache.load("old_coll");
    expect(loaded).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/infra/stats-cache-v3.test.ts` Expected: FAIL —
cache version is 2, doesn't handle distributions.

- [ ] **Step 3: Update StatsCache**

In `src/core/infra/stats-cache.ts`:

1. Bump `CURRENT_VERSION` from 2 to 3
2. Add `distributions` to `StatsFileContent` interface
3. In `save()`: serialize `stats.distributions` into the file
4. In `load()`: deserialize `distributions` back into `CollectionSignalStats`,
   reject version < 3

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/infra/stats-cache-v3.test.ts` Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run` Expected: PASS — any existing StatsCache tests may need
updates for v3 format.

- [ ] **Step 6: Commit**

```bash
git add src/core/infra/stats-cache.ts tests/core/infra/stats-cache-v3.test.ts
git commit -m "feat(infra): bump StatsCache to v3 with distributions support"
```

---

## Chunk 3: Label Resolution in Reranker

### Task 7: Add label resolver to reranker

**Files:**

- Create: `src/core/domains/explore/label-resolver.ts`
- Test: `tests/core/domains/explore/label-resolver.test.ts` (new)

- [ ] **Step 1: Write test for label resolution logic**

```typescript
// tests/core/domains/explore/label-resolver.test.ts
import { describe, expect, it } from "vitest";

import { resolveLabel } from "../../../../src/core/domains/explore/label-resolver.js";

describe("resolveLabel", () => {
  const labels = { p25: "low", p50: "typical", p75: "high", p95: "extreme" };
  const percentiles = { 25: 2, 50: 5, 75: 12, 95: 30 };

  it("should return first label for values below all thresholds", () => {
    expect(resolveLabel(0, labels, percentiles)).toBe("low");
    expect(resolveLabel(1, labels, percentiles)).toBe("low");
  });

  it("should return first label for values in first bucket", () => {
    expect(resolveLabel(2, labels, percentiles)).toBe("low");
    expect(resolveLabel(4, labels, percentiles)).toBe("low");
  });

  it("should return correct bucket label", () => {
    expect(resolveLabel(5, labels, percentiles)).toBe("typical");
    expect(resolveLabel(11, labels, percentiles)).toBe("typical");
    expect(resolveLabel(12, labels, percentiles)).toBe("high");
    expect(resolveLabel(29, labels, percentiles)).toBe("high");
  });

  it("should return last label for values at or above last threshold", () => {
    expect(resolveLabel(30, labels, percentiles)).toBe("extreme");
    expect(resolveLabel(100, labels, percentiles)).toBe("extreme");
  });

  it("should handle two-label signals", () => {
    const twoLabels = { p75: "normal", p95: "high" };
    const twoPercentiles = { 75: 10, 95: 25 };
    expect(resolveLabel(5, twoLabels, twoPercentiles)).toBe("normal");
    expect(resolveLabel(10, twoLabels, twoPercentiles)).toBe("normal");
    expect(resolveLabel(15, twoLabels, twoPercentiles)).toBe("normal");
    expect(resolveLabel(25, twoLabels, twoPercentiles)).toBe("high");
    expect(resolveLabel(50, twoLabels, twoPercentiles)).toBe("high");
  });

  it("should handle collapsed percentiles (identical values)", () => {
    const collapsed = {
      p25: "low",
      p50: "typical",
      p75: "high",
      p95: "extreme",
    };
    const sameValues = { 25: 5, 50: 5, 75: 5, 95: 5 };
    // All thresholds are 5, value 3 < 5 → first label
    expect(resolveLabel(3, collapsed, sameValues)).toBe("low");
    // Value 5 >= all thresholds → last label
    expect(resolveLabel(5, collapsed, sameValues)).toBe("extreme");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/domains/explore/label-resolver.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement resolveLabel**

Create `src/core/domains/explore/label-resolver.ts`:

```typescript
/**
 * Resolves a human-readable label for a numeric value based on
 * percentile thresholds declared in signal descriptor stats.labels.
 *
 * Internal to the reranker — not exported from domain barrel.
 */
export function resolveLabel(
  value: number,
  labels: Record<string, string>,
  percentiles: Record<number, number>,
): string {
  const entries = Object.entries(labels)
    .map(([pKey, label]) => ({ p: Number(pKey.slice(1)), label }))
    .sort((a, b) => a.p - b.p);

  if (entries.length === 0) return "";

  // Walk thresholds in ascending order.
  // Each label covers [threshold, nextThreshold).
  // First label also covers below its threshold.
  // Last label covers at-or-above its threshold.
  let resolved = entries[0].label;
  for (const { p, label } of entries) {
    const threshold = percentiles[p];
    if (threshold !== undefined && value >= threshold) {
      resolved = label;
    }
  }
  return resolved;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/domains/explore/label-resolver.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/explore/label-resolver.ts \
  tests/core/domains/explore/label-resolver.test.ts
git commit -m "feat(reranker): add label-resolver for overlay value labeling"
```

---

### Task 8: Integrate label resolver into reranker buildOverlay()

**Files:**

- Modify: `src/core/domains/explore/reranker.ts`
- Modify: `tests/core/domains/explore/reranker.test.ts`

- [ ] **Step 1: Write test for labeled overlay output**

Add to `tests/core/domains/explore/reranker.test.ts` (find appropriate describe
block for overlay tests):

```typescript
it("should produce { value, label } for signals with stats.labels", () => {
  // Setup: reranker with stats loaded, preset with file overlay mask
  // including a signal that has labels declared
  // Act: call rerank with a point having commitCount value
  // Assert: overlay.file.commitCount should be { value: N, label: "..." }
});

it("should produce plain value for signals without labels", () => {
  // Assert: overlay.file.dominantAuthor should be a plain string
});
```

Note: exact test setup depends on existing reranker test fixtures. The agent
implementing this task should read the existing test file to understand the mock
setup pattern, then add tests that verify:

1. Numeric signals with `stats.labels` → `{ value: number, label: string }`
2. String signals → plain value
3. Overlay has no `derived` field

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/domains/explore/reranker.test.ts` Expected: FAIL
— overlay still produces plain numbers.

- [ ] **Step 3: Store payloadSignals as instance field on Reranker**

The Reranker constructor receives `payloadSignals: PayloadSignalDescriptor[]`
but currently only uses it to build `signalKeyMap` and discards it. To look up
`stats.labels` during overlay building, store it:

In `src/core/domains/explore/reranker.ts` constructor, add:

```typescript
private readonly payloadSignals: PayloadSignalDescriptor[];
```

And in the constructor body:

```typescript
this.payloadSignals = payloadSignals;
```

- [ ] **Step 4: Integrate label resolver into buildOverlay()**

In `src/core/domains/explore/reranker.ts`, in `buildOverlay()`:

1. Import `resolveLabel` from `./label-resolver.js`
2. After collecting raw values into `file`/`chunk` objects, iterate over numeric
   entries
3. For each numeric value: look up the signal descriptor by full key (use
   `this.signalKeyMap` to resolve short name → full key, then find descriptor in
   `this.payloadSignals` with `stats?.labels`)
4. If descriptor has `stats.labels` and `this.collectionStats` has percentiles
   for that signal: call
   `resolveLabel(value, descriptor.stats.labels, percentiles)`
5. Replace the plain value with `{ value, label }`

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/domains/explore/reranker.test.ts` Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run` Expected: PASS — other tests checking overlay format may
need updates.

- [ ] **Step 6: Commit**

```bash
git add src/core/domains/explore/reranker.ts tests/core/domains/explore/
git commit -m "feat(reranker): integrate label resolution into buildOverlay"
```

---

## Chunk 4: IndexMetrics DTO + App + MCP Tool

### Task 9: Create IndexMetrics DTO

**Files:**

- Create: `src/core/api/public/dto/metrics.ts`
- Modify: `src/core/api/public/dto/index.ts` (barrel)
- Test: `tests/core/api/dto/metrics.test.ts` (new)

- [ ] **Step 1: Write test for DTO shape**

```typescript
// tests/core/api/dto/metrics.test.ts
import { describe, expect, it } from "vitest";

import type { IndexMetrics } from "../../../../src/core/api/public/dto/metrics.js";

describe("IndexMetrics DTO", () => {
  it("should have correct shape", () => {
    const metrics: IndexMetrics = {
      collection: "code_abc123",
      totalChunks: 1709,
      totalFiles: 314,
      distributions: {
        totalFiles: 314,
        language: { typescript: 1200 },
        chunkType: { function: 800 },
        documentation: { docs: 150, code: 1559 },
        topAuthors: [{ name: "Alice", chunks: 1400 }],
        othersCount: 309,
      },
      signals: {
        "git.file.commitCount": {
          min: 1,
          max: 47,
          count: 1709,
          labelMap: { low: 2, typical: 5, high: 12, extreme: 30 },
        },
      },
    };
    expect(metrics.collection).toBe("code_abc123");
    expect(metrics.signals["git.file.commitCount"].labelMap.high).toBe(12);
  });

  it("should allow optional mean", () => {
    const metrics: IndexMetrics = {
      collection: "test",
      totalChunks: 0,
      totalFiles: 0,
      distributions: {
        totalFiles: 0,
        language: {},
        chunkType: {},
        documentation: { docs: 0, code: 0 },
        topAuthors: [],
        othersCount: 0,
      },
      signals: {
        "test.signal": {
          min: 0,
          max: 0,
          mean: 5.2,
          count: 0,
          labelMap: {},
        },
      },
    };
    expect(metrics.signals["test.signal"].mean).toBe(5.2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/api/dto/metrics.test.ts` Expected: FAIL — module
doesn't exist.

- [ ] **Step 3: Create DTO**

Create `src/core/api/public/dto/metrics.ts`:

```typescript
import type { Distributions } from "../../../contracts/types/trajectory.js";

/** Signal statistics with label-to-threshold mapping for a single signal. */
export interface SignalMetrics {
  min: number;
  max: number;
  mean?: number;
  count: number;
  /** Label name → threshold value. E.g. { "high": 12, "extreme": 30 } */
  labelMap: Record<string, number>;
}

/** Collection-level metrics returned by get_index_metrics MCP tool. */
export interface IndexMetrics {
  collection: string;
  totalChunks: number;
  totalFiles: number;
  distributions: Distributions;
  signals: Record<string, SignalMetrics>;
}
```

Update barrel `src/core/api/public/dto/index.ts` — add:

```typescript
export type { IndexMetrics, SignalMetrics } from "./metrics.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/api/dto/metrics.test.ts` Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/api/public/dto/metrics.ts src/core/api/public/dto/index.ts \
  tests/core/api/dto/metrics.test.ts
git commit -m "feat(dto): add IndexMetrics DTO for get_index_metrics"
```

---

### Task 10: Add getIndexMetrics to App interface and ExploreFacade

**Files:**

- Modify: `src/core/api/public/app.ts`
- Modify: `src/core/api/internal/facades/explore-facade.ts`
- Test: `tests/core/api/get-index-metrics.test.ts` (new)

- [ ] **Step 1: Write integration test**

```typescript
// tests/core/api/get-index-metrics.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

// Test that getIndexMetrics returns correct IndexMetrics from cached stats.
// Mock: StatsCache.load returns pre-built CollectionSignalStats with
// distributions and perSignal. Mock: qdrant.collectionExists → true,
// collection info with pointsCount.
// Assert: returned IndexMetrics has correct collection name, totalChunks,
// totalFiles, distributions, and signals with labelMap.

// Note: exact test setup depends on how createApp() and ExploreFacade
// are wired. The agent should read existing test patterns in
// tests/core/api/ to match the mock setup convention.
```

The implementing agent should write a concrete test based on existing patterns
in `tests/core/api/`. Key assertions:

1. `metrics.collection` matches resolved collection name
2. `metrics.totalChunks` matches `pointsCount` from collection info
3. `metrics.totalFiles` matches `distributions.totalFiles` from stats
4. `metrics.distributions` matches cached distributions
5. `metrics.signals["git.file.commitCount"].labelMap` has correct label →
   threshold mapping built from `stats.labels` + cached percentiles

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/api/get-index-metrics.test.ts` Expected: FAIL —
`getIndexMetrics` doesn't exist.

- [ ] **Step 3: Add to App interface**

In `src/core/api/public/app.ts`, add to `App` interface:

```typescript
/** Get collection statistics and signal distributions with label thresholds. */
getIndexMetrics: (path: string) => Promise<IndexMetrics>;
```

Add import:

```typescript
import type { IndexMetrics } from "./dto/metrics.js";
```

In `createApp()` function, add implementation:

```typescript
getIndexMetrics: (path) => deps.explore.getIndexMetrics(path),
```

- [ ] **Step 4: Implement in ExploreFacade**

In `src/core/api/internal/facades/explore-facade.ts`, add method:

```typescript
async getIndexMetrics(path: string): Promise<IndexMetrics> {
  const absolutePath = await validatePath(path);
  const collectionName = resolveCollectionName(absolutePath);

  if (!(await this.qdrant.collectionExists(collectionName))) {
    throw new Error(`Collection not found. Index the codebase first.`);
  }

  // Ensure stats are loaded
  await this.ensureStats(collectionName);

  const stats = this.statsCache?.load(collectionName);
  if (!stats) {
    throw new Error(`No statistics available. Re-index the codebase.`);
  }

  const collectionInfo = await this.qdrant.getCollectionInfo(collectionName);

  // Build signals with labelMap
  const signals: Record<string, SignalMetrics> = {};
  const descriptors = this.deps.payloadSignals ?? [];

  for (const [key, signalStats] of stats.perSignal) {
    const descriptor = descriptors.find((d) => d.key === key);
    if (!descriptor?.stats?.labels) continue;

    const labelMap: Record<string, number> = {};
    for (const [pKey, labelName] of Object.entries(descriptor.stats.labels)) {
      const p = Number(pKey.slice(1));
      const threshold = signalStats.percentiles[p];
      if (threshold !== undefined) {
        labelMap[labelName] = threshold;
      }
    }

    signals[key] = {
      min: signalStats.min,
      max: signalStats.max,
      mean: signalStats.mean,
      count: signalStats.count,
      labelMap,
    };
  }

  return {
    collection: collectionName,
    totalChunks: collectionInfo.pointsCount,
    totalFiles: stats.distributions.totalFiles,
    distributions: stats.distributions,
    signals,
  };
}
```

Add imports for `IndexMetrics`, `SignalMetrics`, `validatePath`,
`resolveCollectionName`.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/core/api/get-index-metrics.test.ts` Expected: PASS

- [ ] **Step 6: Run full test suite**

Run: `npx vitest run` Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/core/api/public/app.ts \
  src/core/api/internal/facades/explore-facade.ts \
  tests/core/api/get-index-metrics.test.ts
git commit -m "feat(api): add getIndexMetrics to App interface and ExploreFacade"
```

---

### Task 11: Register `get_index_metrics` MCP tool

**Files:**

- Modify: `src/mcp/tools/code.ts` (or appropriate tool file)
- Modify: `src/mcp/tools/index.ts` (if needed for registration)

- [ ] **Step 1: Add MCP tool registration**

Follow the existing pattern in `src/mcp/tools/` (look at `collection.ts` or
`code.ts` for examples). Register:

```typescript
server.tool(
  "get_index_metrics",
  "Get collection statistics and signal distributions. Returns percentile-based thresholds for git signals, language/author/chunkType distributions. Use to discover appropriate filter values for your codebase.",
  { path: z.string().describe("Path to codebase") },
  { readOnlyHint: true },
  async ({ path }) => {
    const metrics = await app.getIndexMetrics(path);
    return {
      content: [{ type: "text", text: JSON.stringify(metrics, null, 2) }],
    };
  },
);
```

- [ ] **Step 2: Build and verify no type errors**

Run: `npm run build` Expected: Clean build.

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run` Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/mcp/tools/
git commit -m "feat(mcp): register get_index_metrics tool"
```

---

## Dependency Graph

```
Task 1 (SignalStatsRequest labels)
  └─► Task 4 (signal descriptor migration) ─► Task 5 (computeCollectionStats)
Task 2 (SignalStats min/max + Distributions)
  └─► Task 5 (computeCollectionStats) ─► Task 6 (StatsCache v3)
Task 3 (remove derived)
  └─► Task 8 (reranker overlay integration)
Task 7 (label-resolver) ─► Task 8 (reranker integration)
Task 9 (IndexMetrics DTO) ─► Task 10 (App + Facade)
Task 10 (App + Facade) ─► Task 11 (MCP tool)
```

**Parallelizable groups:**

- Group A: Tasks 1, 2, 3 (contracts — all independent)
- Group B: Task 4 (after Task 1)
- Group C: Tasks 5, 6 (after Tasks 1, 2, 4 — sequential)
- Group D: Tasks 7, 8 (after Task 3 — sequential)
- Group E: Tasks 9, 10, 11 (after Tasks 5, 6, 8 — sequential)
