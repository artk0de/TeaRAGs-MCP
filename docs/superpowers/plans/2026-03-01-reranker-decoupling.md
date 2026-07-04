# Reranker Decoupling & Trajectory Interface — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to
> implement this plan task-by-task.

**Goal:** Make the reranker a fully generic scoring engine with zero
trajectory-specific knowledge. Introduce `Trajectory` as the central interface
(ISP over `EnrichmentProvider`). Fix stale filter keys.

**Architecture:** Trajectory declares its payload signals, derived signals,
filters, and presets. Registry aggregates. Reranker reads payload via
dot-notation from `PayloadSignalDescriptor.key`. Confidence dampening moves into
each descriptor's `extract()`. Collection-wide stats cached until reindex.

**Tech Stack:** TypeScript, Vitest, Qdrant

**Design:** `docs/plans/2026-03-01-reranker-decoupling-design.md`

**Beads:** Epic `tea-rags-mcp-k62`, related: `tea-rags-mcp-462`,
`tea-rags-mcp-7w4`, `tea-rags-mcp-w07`, `tea-rags-mcp-d56`

---

## Task 1: New Types — PayloadSignalDescriptor, ExtractContext, SignalStats, CollectionSignalStats

**Files:**

- Create: `src/core/contracts/types/trajectory.ts`
- Modify: `src/core/contracts/index.ts` (add re-export)
- Test: `tests/core/contracts/types/trajectory.test.ts`

### Step 1: Write failing test

```typescript
// tests/core/contracts/types/trajectory.test.ts
import { describe, expect, it } from "vitest";

import type {
  CollectionSignalStats,
  ExtractContext,
  PayloadSignalDescriptor,
  SignalStats,
} from "../../../../src/core/contracts/types/trajectory.js";

describe("PayloadSignalDescriptor", () => {
  it("represents a raw payload field descriptor", () => {
    const signal: PayloadSignalDescriptor = {
      key: "git.file.commitCount",
      type: "number",
      description: "Total commits modifying this file",
    };
    expect(signal.key).toBe("git.file.commitCount");
    expect(signal.type).toBe("number");
    expect(signal.description).toBeTruthy();
  });
});

describe("SignalStats", () => {
  it("holds percentile distribution", () => {
    const stats: SignalStats = { p25: 3, p50: 8, p75: 20, p95: 50, count: 100 };
    expect(stats.p25).toBeLessThan(stats.p50);
    expect(stats.count).toBeGreaterThan(0);
  });
});

describe("CollectionSignalStats", () => {
  it("holds per-signal stats with timestamp", () => {
    const stats: CollectionSignalStats = {
      perSignal: new Map([
        [
          "git.file.commitCount",
          { p25: 3, p50: 8, p75: 20, p95: 50, count: 100 },
        ],
      ]),
      computedAt: Date.now(),
    };
    expect(stats.perSignal.get("git.file.commitCount")?.p50).toBe(8);
    expect(stats.computedAt).toBeGreaterThan(0);
  });
});

describe("ExtractContext", () => {
  it("combines bound and collectionStats", () => {
    const ctx: ExtractContext = {
      bound: 365,
      collectionStats: {
        perSignal: new Map(),
        computedAt: Date.now(),
      },
    };
    expect(ctx.bound).toBe(365);
    expect(ctx.collectionStats).toBeDefined();
  });

  it("allows partial context (bound only)", () => {
    const ctx: ExtractContext = { bound: 50 };
    expect(ctx.collectionStats).toBeUndefined();
  });

  it("allows empty context", () => {
    const ctx: ExtractContext = {};
    expect(ctx.bound).toBeUndefined();
  });
});
```

### Step 2: Run test to verify it fails

Run: `npx vitest run tests/core/contracts/types/trajectory.test.ts` Expected:
FAIL — module not found

### Step 3: Write implementation

```typescript
// src/core/contracts/types/trajectory.ts
/**
 * Trajectory type system — payload signals, stats, and extraction context.
 */

/** Raw Qdrant payload field descriptor — key + type + description. */
export interface PayloadSignalDescriptor {
  /** Full Qdrant payload path (e.g. "git.file.commitCount") */
  key: string;
  /** Data type */
  type: "string" | "number" | "boolean" | "string[]" | "timestamp";
  /** Human-readable description */
  description: string;
}

/** Percentile distribution for a single numeric signal across the collection. */
export interface SignalStats {
  p25: number;
  p50: number;
  p75: number;
  p95: number;
  count: number;
}

/** Collection-wide signal statistics, cached between reindexes. */
export interface CollectionSignalStats {
  perSignal: Map<string, SignalStats>;
  computedAt: number;
}

/** Context passed to DerivedSignalDescriptor.extract() for adaptive normalization. */
export interface ExtractContext {
  /** Adaptive bound from result batch (p95, floored with defaultBound) */
  bound?: number;
  /** Collection-wide signal stats (cached until reindex) */
  collectionStats?: CollectionSignalStats;
}
```

Add re-export to `src/core/contracts/index.ts`.

### Step 4: Run test to verify it passes

Run: `npx vitest run tests/core/contracts/types/trajectory.test.ts` Expected:
PASS

### Step 5: Verify all tests still pass

Run: `npx tsc --noEmit && npx vitest run` Expected: 0 errors, all tests pass

### Step 6: Commit

```bash
git add src/core/contracts/types/trajectory.ts src/core/contracts/index.ts tests/core/contracts/types/trajectory.test.ts
git commit -m "feat(contracts): add PayloadSignalDescriptor, ExtractContext, SignalStats types"
```

---

## Task 2: Update DerivedSignalDescriptor.extract() signature

**Files:**

- Modify: `src/core/contracts/types/reranker.ts` (change extract signature,
  remove needsConfidence/confidenceField)
- Modify: `tests/core/search/reranker.test.ts` (update mock descriptors)
- Modify: All 14 git derived signal classes (update extract signature)
- Modify: All 5 structural signal classes (update extract signature)

### Step 1: Update DerivedSignalDescriptor interface

In `src/core/contracts/types/reranker.ts`:

```typescript
import type { ExtractContext } from "./trajectory.js";

export interface DerivedSignalDescriptor {
  name: string;
  description: string;
  sources: string[];
  /** Extract normalized value (0-1) from raw signals.
   *  ctx provides adaptive bound and collection stats. */
  extract: (
    rawSignals: Record<string, unknown>,
    ctx?: ExtractContext,
  ) => number;
  defaultBound?: number;
  // REMOVED: needsConfidence, confidenceField
}
```

### Step 2: Update all 14 git derived signal classes

Each class changes `extract(payload: Record<string, unknown>, bound?: number)`
to `extract(rawSignals: Record<string, unknown>, ctx?: ExtractContext)`.

For signals WITHOUT confidence (8 signals): straightforward — replace `bound`
with `ctx?.bound`.

Example — `recency.ts`:

```typescript
extract(rawSignals: Record<string, unknown>, ctx?: ExtractContext): number {
  const b = ctx?.bound ?? 365;
  const effectiveAge = blendSignal(rawSignals, "ageDays");
  return 1 - normalize(effectiveAge, b);
}
```

For signals WITH confidence (6 signals): move dampening into extract(). Each
picks its own threshold from ctx.collectionStats or uses a hardcoded fallback.
Details in Task 3.

### Step 3: Update all 5 structural signal classes

Same signature change. These never used `bound` as first arg — they used
positional. Change to `ctx?.bound`.

### Step 4: Update reranker.test.ts mock descriptors

All mock descriptors in tests use `extract(payload, bound?)` — update to
`extract(rawSignals, ctx?)`.

### Step 5: Run verification

Run: `npx tsc --noEmit && npx vitest run` Expected: 0 errors, all tests pass

### Step 6: Commit

```bash
git commit -m "refactor(contracts): update DerivedSignalDescriptor.extract() to (rawSignals, ctx?)"
```

---

## Task 3: Move confidence dampening into descriptors

**Files:**

- Modify: 6 descriptor files (bug-fix.ts, volatility.ts, ownership.ts,
  knowledge-silo.ts, density.ts, relative-churn-norm.ts)
- Modify: `src/core/search/reranker.ts` (remove CONFIDENCE_THRESHOLDS,
  signalConfidence, confidence dampening from extractAllDerived)
- Test: `tests/core/trajectory/git/derived-signals/confidence.test.ts` (new)
- Modify: `tests/core/search/reranker.test.ts` (remove confidence dampening
  tests from reranker, they move to descriptor tests)

### Step 1: Write failing test for self-dampening descriptors

```typescript
// tests/core/trajectory/git/derived-signals/confidence.test.ts
import { describe, expect, it } from "vitest";

import type {
  CollectionSignalStats,
  ExtractContext,
} from "../../../../src/core/contracts/types/trajectory.js";
import { BugFixSignal } from "../../../../src/core/trajectory/git/rerank/derived-signals/bug-fix.js";
import { OwnershipSignal } from "../../../../src/core/trajectory/git/rerank/derived-signals/ownership.js";

function makePayload(fileCommitCount: number, fileBugFixRate: number) {
  return {
    git: { file: { commitCount: fileCommitCount, bugFixRate: fileBugFixRate } },
  };
}

function makeStats(key: string, p25: number): CollectionSignalStats {
  return {
    perSignal: new Map([
      [key, { p25, p50: p25 * 2, p75: p25 * 4, p95: p25 * 8, count: 100 }],
    ]),
    computedAt: Date.now(),
  };
}

describe("BugFixSignal self-dampening", () => {
  const signal = new BugFixSignal();

  it("returns full value when commitCount >= adaptive threshold", () => {
    const payload = makePayload(20, 50);
    const ctx: ExtractContext = {
      bound: 100,
      collectionStats: makeStats("git.file.commitCount", 8),
    };
    const value = signal.extract(payload, ctx);
    // With 20 commits and threshold p25=8, confidence=1.0
    expect(value).toBeCloseTo(0.5); // 50/100
  });

  it("dampens value when commitCount < adaptive threshold", () => {
    const payload = makePayload(2, 50);
    const ctx: ExtractContext = {
      bound: 100,
      collectionStats: makeStats("git.file.commitCount", 8),
    };
    const value = signal.extract(payload, ctx);
    // (2/8)^2 = 0.0625, base = 0.5, dampened = 0.03125
    expect(value).toBeCloseTo(0.03125);
  });

  it("uses fallback threshold when no stats available", () => {
    const payload = makePayload(2, 50);
    const ctx: ExtractContext = { bound: 100 };
    const value = signal.extract(payload, ctx);
    // Fallback k=8 for bugFix, (2/8)^2 = 0.0625, base = 0.5
    expect(value).toBeCloseTo(0.03125);
  });
});

describe("OwnershipSignal self-dampening", () => {
  const signal = new OwnershipSignal();

  it("dampens with adaptive threshold from stats", () => {
    const payload = {
      git: { file: { commitCount: 2, dominantAuthorPct: 80 } },
    };
    const ctx: ExtractContext = {
      collectionStats: makeStats("git.file.commitCount", 5),
    };
    const value = signal.extract(payload, ctx);
    // base = 0.8, confidence = (2/5)^2 = 0.16, dampened = 0.128
    expect(value).toBeCloseTo(0.128);
  });
});
```

### Step 2: Run test to verify it fails

Run:
`npx vitest run tests/core/trajectory/git/derived-signals/confidence.test.ts`
Expected: FAIL — descriptors don't do self-dampening yet

### Step 3: Implement self-dampening in each descriptor

Add a private helper to helpers.ts:

```typescript
// In helpers.ts
const CONFIDENCE_POWER = 2;

/** Quadratic confidence dampening. Returns 1 when n >= k, otherwise (n/k)^2. */
export function confidenceDampening(
  effectiveCommitCount: number,
  threshold: number,
): number {
  if (effectiveCommitCount >= threshold) return 1;
  if (threshold <= 0) return 1;
  return Math.pow(effectiveCommitCount / threshold, CONFIDENCE_POWER);
}
```

Update each of the 6 descriptors. Example — `BugFixSignal`:

```typescript
import type { ExtractContext } from "../../../../contracts/types/trajectory.js";
import { blendSignal, confidenceDampening, fileNum } from "./helpers.js";

export class BugFixSignal implements DerivedSignalDescriptor {
  readonly name = "bugFix";
  readonly description =
    "Bug fix rate: code with more fix commits scores higher. L3 blends chunk+file bugFixRate.";
  readonly sources = ["bugFixRate"];
  readonly defaultBound = 100;
  // REMOVED: needsConfidence, confidenceField

  /** Fallback confidence threshold when no collection stats available */
  private static readonly FALLBACK_THRESHOLD = 8;

  extract(rawSignals: Record<string, unknown>, ctx?: ExtractContext): number {
    const b = ctx?.bound ?? 100;
    const effectiveBFR = blendSignal(rawSignals, "bugFixRate");
    let value = normalize(effectiveBFR, b);

    // Self-dampening: use p25 from collection stats or fallback
    const stats = ctx?.collectionStats?.perSignal.get("git.file.commitCount");
    const k = stats?.p25 ?? BugFixSignal.FALLBACK_THRESHOLD;
    const commitCount = fileNum(rawSignals, "commitCount");
    value *= confidenceDampening(commitCount, k);

    return value;
  }
}
```

**Threshold table (from design):**

| Descriptor              | Fallback k | Stat key               | Percentile |
| ----------------------- | ---------- | ---------------------- | ---------- |
| BugFixSignal            | 8          | `git.file.commitCount` | p25        |
| VolatilitySignal        | 8          | `git.file.commitCount` | p25        |
| OwnershipSignal         | 5          | `git.file.commitCount` | p25        |
| KnowledgeSiloSignal     | 5          | `git.file.commitCount` | p25        |
| DensitySignal           | 5          | `git.file.commitCount` | p25        |
| RelativeChurnNormSignal | 5          | `git.file.commitCount` | p25        |

### Step 4: Remove confidence logic from reranker.ts

Remove:

- `CONFIDENCE_THRESHOLDS` (lines 37-44)
- `DEFAULT_CONFIDENCE_THRESHOLD`, `CONFIDENCE_POWER` (lines 45-46)
- `signalConfidence()` export (lines 52-56)
- `getEffectiveConfidenceValue()` private method (lines 235-257)
- Confidence dampening block in `extractAllDerived()` (lines 220-228)

Update `extractAllDerived()` to pass `ExtractContext`:

```typescript
private extractAllDerived(payload: Record<string, unknown>, bounds: Map<string, number>): Record<string, number> {
  const signals: Record<string, number> = {};
  for (const d of this.descriptors) {
    const bound = bounds.get(d.name);
    const ctx: ExtractContext = { bound, collectionStats: this.collectionStats };
    signals[d.name] = d.extract(payload, ctx);
  }
  return signals;
}
```

Add `collectionStats` field + setter to Reranker:

```typescript
private collectionStats?: CollectionSignalStats;

setCollectionStats(stats: CollectionSignalStats): void {
  this.collectionStats = stats;
}

invalidateStats(): void {
  this.collectionStats = undefined;
}
```

### Step 5: Update reranker.test.ts

Remove/update tests that tested confidence dampening in the reranker. The
confidence behavior is now tested in descriptor-level tests.

### Step 6: Run verification

Run: `npx tsc --noEmit && npx vitest run` Expected: 0 errors, all tests pass

### Step 7: Commit

```bash
git commit -m "refactor: move confidence dampening into descriptors with adaptive thresholds"
```

---

## Task 4: Fix filter keys — level-aware, correct Qdrant paths

**Bead:** `tea-rags-mcp-462`

**Files:**

- Modify: `src/core/trajectory/git/filters.ts`
- Modify: `tests/core/trajectory/git/filters.test.ts` (or create)
- Modify: `src/core/search/search-module.ts` (fix stale inline keys)

### Step 1: Write failing test for level-aware filters

```typescript
// tests/core/trajectory/git/filters.test.ts
import { describe, expect, it } from "vitest";

import { gitFilters } from "../../../../src/core/trajectory/git/filters.js";

describe("gitFilters level-aware keys", () => {
  const findFilter = (param: string) =>
    gitFilters.find((f) => f.param === param)!;

  it("author uses git.file.dominantAuthor (file-only)", () => {
    const conditions = findFilter("author").toCondition("Alice");
    expect(conditions[0].key).toBe("git.file.dominantAuthor");
  });

  it("minAgeDays defaults to chunk level", () => {
    const conditions = findFilter("minAgeDays").toCondition(30);
    expect(conditions[0].key).toBe("git.chunk.ageDays");
  });

  it("minAgeDays respects file level", () => {
    const conditions = findFilter("minAgeDays").toCondition(30, "file");
    expect(conditions[0].key).toBe("git.file.ageDays");
  });

  it("minCommitCount defaults to chunk level", () => {
    const conditions = findFilter("minCommitCount").toCondition(5);
    expect(conditions[0].key).toBe("git.chunk.commitCount");
  });

  it("minCommitCount respects file level", () => {
    const conditions = findFilter("minCommitCount").toCondition(5, "file");
    expect(conditions[0].key).toBe("git.file.commitCount");
  });

  it("modifiedAfter uses git.file.lastModifiedAt (file-only)", () => {
    const conditions = findFilter("modifiedAfter").toCondition("2025-01-01");
    expect(conditions[0].key).toBe("git.file.lastModifiedAt");
  });

  it("taskId uses git.file.taskIds (file-only)", () => {
    const conditions = findFilter("taskId").toCondition("TD-123");
    expect(conditions[0].key).toBe("git.file.taskIds");
  });
});
```

### Step 2: Run test to verify it fails

Run: `npx vitest run tests/core/trajectory/git/filters.test.ts` Expected: FAIL —
current keys are stale flat keys

### Step 3: Fix filter keys

```typescript
// src/core/trajectory/git/filters.ts
import type { FilterDescriptor, FilterLevel } from "../../contracts/index.js";

export const gitFilters: FilterDescriptor[] = [
  {
    param: "author",
    description: "Filter by dominant author name",
    type: "string",
    toCondition: (value: unknown) => [
      { key: "git.file.dominantAuthor", match: { value: value as string } },
    ],
  },
  {
    param: "modifiedAfter",
    description: "Filter code modified after this date (ISO string)",
    type: "string",
    toCondition: (value: unknown) => [
      {
        key: "git.file.lastModifiedAt",
        range: { gte: Math.floor(new Date(value as string).getTime() / 1000) },
      },
    ],
  },
  {
    param: "modifiedBefore",
    description: "Filter code modified before this date (ISO string)",
    type: "string",
    toCondition: (value: unknown) => [
      {
        key: "git.file.lastModifiedAt",
        range: { lte: Math.floor(new Date(value as string).getTime() / 1000) },
      },
    ],
  },
  {
    param: "minAgeDays",
    description: "Filter code older than N days",
    type: "number",
    toCondition: (value: unknown, level: FilterLevel = "chunk") => [
      { key: `git.${level}.ageDays`, range: { gte: value as number } },
    ],
  },
  {
    param: "maxAgeDays",
    description: "Filter code newer than N days",
    type: "number",
    toCondition: (value: unknown, level: FilterLevel = "chunk") => [
      { key: `git.${level}.ageDays`, range: { lte: value as number } },
    ],
  },
  {
    param: "minCommitCount",
    description: "Filter by minimum commit count (churn indicator)",
    type: "number",
    toCondition: (value: unknown, level: FilterLevel = "chunk") => [
      { key: `git.${level}.commitCount`, range: { gte: value as number } },
    ],
  },
  {
    param: "taskId",
    description: "Filter by task/ticket ID from commit messages",
    type: "string",
    toCondition: (value: unknown) => [
      { key: "git.file.taskIds", match: { any: [value as string] } },
    ],
  },
];
```

### Step 4: Fix stale keys in search-module.ts

Update inline keys in `searchCode()` to match the corrected filter keys:

- `git.dominantAuthor` → `git.file.dominantAuthor`
- `git.lastModifiedAt` → `git.file.lastModifiedAt`
- `git.ageDays` → `git.chunk.ageDays`
- `git.commitCount` → `git.chunk.commitCount`
- `git.taskIds` → `git.file.taskIds`

(These inline keys will be fully removed in Task 7 when search-module delegates
to registry, but fix them now so tests pass.)

### Step 5: Run verification

Run: `npx tsc --noEmit && npx vitest run` Expected: 0 errors, all tests pass

### Step 6: Commit

```bash
git commit -m "fix(filters): correct stale Qdrant keys, add level-aware ageDays/commitCount"
```

---

## Task 5: Convert signals.ts from Signal[] to PayloadSignalDescriptor[]

**Files:**

- Modify: `src/core/trajectory/git/signals.ts` (change type, remove `name` and
  `defaultBound`)
- Modify: `src/core/trajectory/git/provider.ts` (update import)
- Test: `tests/core/trajectory/git/signals.test.ts` (update expectations)

### Step 1: Write/update failing test

```typescript
// In tests/core/trajectory/git/signals.test.ts — update import and assertions
import type { PayloadSignalDescriptor } from "../../../../src/core/contracts/types/trajectory.js";
import { gitPayloadSignalDescriptors } from "../../../../src/core/trajectory/git/signals.js";

describe("gitPayloadSignalDescriptors", () => {
  it("are PayloadSignalDescriptor[] (key + type + description only)", () => {
    for (const signal of gitPayloadSignalDescriptors) {
      expect(signal).toHaveProperty("key");
      expect(signal).toHaveProperty("type");
      expect(signal).toHaveProperty("description");
      // Should NOT have name or defaultBound
      expect(signal).not.toHaveProperty("name");
      expect(signal).not.toHaveProperty("defaultBound");
    }
  });
});
```

### Step 2: Run test to verify it fails

Expected: FAIL — `gitPayloadSignalDescriptors` doesn't exist (current export is
`gitSignals: Signal[]`)

### Step 3: Convert signals.ts

Rename export from `gitSignals: Signal[]` to
`gitPayloadSignalDescriptors: PayloadSignalDescriptor[]`. Remove `name` and
`defaultBound` fields from every entry.

```typescript
// src/core/trajectory/git/signals.ts
import type { PayloadSignalDescriptor } from "../../contracts/types/trajectory.js";

export const gitPayloadSignalDescriptors: PayloadSignalDescriptor[] = [
  {
    key: "git.file.commitCount",
    type: "number",
    description: "Total commits modifying this file",
  },
  {
    key: "git.file.ageDays",
    type: "number",
    description: "Days since last modification",
  },
  // ... all other entries, just key + type + description
];
```

### Step 4: Update provider.ts import

`gitSignals` → `gitPayloadSignalDescriptors`, `Signal` →
`PayloadSignalDescriptor`.

### Step 5: Update all consumers of `gitSignals`

Search for `gitSignals` imports and update to `gitPayloadSignalDescriptors`.
Update `EnrichmentProvider.signals` type from `Signal[]` to
`PayloadSignalDescriptor[]` (in provider.ts interface).

### Step 6: Run verification

Run: `npx tsc --noEmit && npx vitest run` Expected: 0 errors, all tests pass

### Step 7: Commit

```bash
git commit -m "refactor(trajectory): convert gitSignals to gitPayloadSignalDescriptors: PayloadSignalDescriptor[]"
```

---

## Task 6: BASE_PAYLOAD_SIGNALS in contracts/

**Files:**

- Create: `src/core/contracts/payload-signals.ts`
- Modify: `src/core/contracts/index.ts` (re-export)
- Test: `tests/core/contracts/payload-signals.test.ts`

### Step 1: Write failing test

```typescript
// tests/core/contracts/payload-signals.test.ts
import { describe, expect, it } from "vitest";

import { BASE_PAYLOAD_SIGNALS } from "../../../../src/core/contracts/payload-signals.js";

describe("BASE_PAYLOAD_SIGNALS", () => {
  it("includes relativePath", () => {
    expect(
      BASE_PAYLOAD_SIGNALS.find((s) => s.key === "relativePath"),
    ).toBeDefined();
  });

  it("includes language", () => {
    expect(
      BASE_PAYLOAD_SIGNALS.find((s) => s.key === "language"),
    ).toBeDefined();
  });

  it("includes isDocumentation", () => {
    expect(
      BASE_PAYLOAD_SIGNALS.find((s) => s.key === "isDocumentation"),
    ).toBeDefined();
  });

  it("all entries have key, type, description", () => {
    for (const signal of BASE_PAYLOAD_SIGNALS) {
      expect(signal.key).toBeTruthy();
      expect(signal.type).toBeTruthy();
      expect(signal.description).toBeTruthy();
    }
  });
});
```

### Step 2: Run test to verify it fails

Expected: FAIL — module not found

### Step 3: Implement

```typescript
// src/core/contracts/payload-signals.ts
import type { PayloadSignalDescriptor } from "./types/trajectory.js";

/** Static payload signals present on every indexed point, regardless of trajectory. */
export const BASE_PAYLOAD_SIGNALS: PayloadSignalDescriptor[] = [
  {
    key: "relativePath",
    type: "string",
    description: "File path relative to project root",
  },
  {
    key: "fileExtension",
    type: "string",
    description: "File extension (e.g. '.ts')",
  },
  { key: "language", type: "string", description: "Programming language" },
  {
    key: "startLine",
    type: "number",
    description: "Start line of chunk in file",
  },
  { key: "endLine", type: "number", description: "End line of chunk in file" },
  {
    key: "chunkIndex",
    type: "number",
    description: "Chunk position within file",
  },
  {
    key: "isDocumentation",
    type: "boolean",
    description: "Whether chunk is documentation",
  },
  {
    key: "chunkType",
    type: "string",
    description: "Chunk type (function, class, block, etc.)",
  },
  {
    key: "name",
    type: "string",
    description: "Symbol name (class, function, etc.)",
  },
  { key: "parentName", type: "string", description: "Parent symbol name" },
  { key: "parentType", type: "string", description: "Parent symbol type" },
  {
    key: "imports",
    type: "string[]",
    description: "File-level imports inherited by all chunks",
  },
];
```

### Step 4: Run verification

Run: `npx tsc --noEmit && npx vitest run` Expected: 0 errors, all tests pass

### Step 5: Commit

```bash
git commit -m "feat(contracts): add BASE_PAYLOAD_SIGNALS for static payload fields"
```

---

## Task 7: Generic Reranker — remove hardcode, add PayloadSignalDescriptor[] + dot-notation

**Files:**

- Modify: `src/core/search/reranker.ts`
- Modify: `tests/core/search/reranker.test.ts`

### Step 1: Write failing tests for new Reranker capabilities

```typescript
// Add to reranker.test.ts
describe("Reranker with PayloadSignalDescriptor[]", () => {
  it("constructs signalKeyMap from PayloadSignalDescriptor[]", () => {
    const payloadSignals: PayloadSignalDescriptor[] = [
      { key: "git.file.ageDays", type: "number", description: "age" },
      { key: "git.file.commitCount", type: "number", description: "commits" },
    ];
    const reranker = new Reranker([], [], payloadSignals);
    // Test via readPayloadPath indirectly through overlay building
    // (signalKeyMap is private, test through behavior)
  });

  it("reads payload via dot-notation path", () => {
    const payloadSignals: PayloadSignalDescriptor[] = [
      { key: "git.file.ageDays", type: "number", description: "age" },
    ];
    const desc: DerivedSignalDescriptor = {
      name: "age",
      description: "test",
      sources: ["ageDays"],
      defaultBound: 365,
      extract: (raw, ctx) => (raw as any).git?.file?.ageDays ?? 0,
    };
    const preset: RerankPreset = {
      name: "test",
      description: "test",
      tools: ["search_code"],
      weights: { age: 1.0 },
      overlayMask: { file: ["ageDays"] },
    };
    const reranker = new Reranker([desc], [preset], payloadSignals);
    const results = [
      { score: 0.9, payload: { git: { file: { ageDays: 100 } } } },
    ];
    const reranked = reranker.rerank(results, "test", "search_code");
    expect(reranked[0].rankingOverlay?.file).toHaveProperty("ageDays", 100);
  });
});

describe("Reranker.setCollectionStats", () => {
  it("passes stats to extract context", () => {
    // ...test that stats flow through to descriptor.extract()
  });
});
```

### Step 2: Run test to verify it fails

Expected: FAIL — Reranker constructor doesn't accept PayloadSignalDescriptor[]

### Step 3: Implement generic Reranker

Constructor changes:

```typescript
constructor(
  private readonly descriptors: DerivedSignalDescriptor[],
  private readonly resolvedPresets: RerankPreset[],
  payloadSignals: PayloadSignalDescriptor[] = [],
) {
  this.descriptorMap = new Map();
  for (const d of this.descriptors) {
    this.descriptorMap.set(d.name, d);
  }
  // Build signalKeyMap: short name → full Qdrant path
  this.signalKeyMap = new Map();
  for (const ps of payloadSignals) {
    const shortName = ps.key.split(".").pop()!;
    this.signalKeyMap.set(shortName, ps.key);
  }
}
```

Add generic `readPayloadPath(payload, dottedPath)`:

```typescript
private readPayloadPath(payload: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = payload;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
```

Replace `readRawSource()` with generic version using `signalKeyMap`:

```typescript
private readRawSource(result: RerankableResult, source: string): number | undefined {
  // Resolve short name to full Qdrant path via signalKeyMap
  const fullPath = this.signalKeyMap.get(source);
  if (fullPath) {
    const val = this.readPayloadPath(result.payload ?? {}, fullPath);
    return typeof val === "number" ? val : undefined;
  }
  // Fallback: check if source is itself a dotted path
  if (source.includes(".")) {
    const val = this.readPayloadPath(result.payload ?? {}, source);
    return typeof val === "number" ? val : undefined;
  }
  return undefined;
}
```

Replace `extractRawSource()` similarly.

Remove `getEffectiveConfidenceValue()` entirely (already moved to descriptors in
Task 3).

### Step 4: Update factory.ts to pass payloadSignals

```typescript
const reranker = new Reranker(
  allDescriptors,
  resolvedPresets,
  allPayloadSignalDescriptors,
);
```

### Step 5: Run verification

Run: `npx tsc --noEmit && npx vitest run` Expected: 0 errors, all tests pass

### Step 6: Commit

```bash
git commit -m "refactor(search): generic Reranker with PayloadSignalDescriptor[] and dot-notation traversal"
```

---

## Task 8: Trajectory interface + GitTrajectory

**Files:**

- Create: `src/core/contracts/types/trajectory.ts` (add Trajectory interface —
  same file as Task 1)
- Create: `src/core/trajectory/git.ts` (GitTrajectory class)
- Modify: `src/core/trajectory/git/provider.ts` (remove query-side fields,
  ingest-only)
- Test: `tests/core/trajectory/git.test.ts`

### Step 1: Write failing test

```typescript
// tests/core/trajectory/git.test.ts
import { describe, expect, it } from "vitest";

import { GitTrajectory } from "../../../src/core/trajectory/git.js";

describe("GitTrajectory", () => {
  const trajectory = new GitTrajectory();

  it("has key 'git'", () => {
    expect(trajectory.key).toBe("git");
  });

  it("has name and description", () => {
    expect(trajectory.name).toBeTruthy();
    expect(trajectory.description).toBeTruthy();
  });

  it("exposes payloadSignals", () => {
    expect(trajectory.payloadSignals.length).toBeGreaterThan(0);
    expect(trajectory.payloadSignals[0]).toHaveProperty("key");
    expect(trajectory.payloadSignals[0]).toHaveProperty("type");
  });

  it("exposes derivedSignals", () => {
    expect(trajectory.derivedSignals.length).toBeGreaterThan(0);
  });

  it("exposes filters", () => {
    expect(trajectory.filters.length).toBeGreaterThan(0);
  });

  it("exposes presets", () => {
    expect(trajectory.presets.length).toBeGreaterThan(0);
  });

  it("exposes enrichment provider (ISP)", () => {
    expect(trajectory.enrichment).toBeDefined();
    expect(typeof trajectory.enrichment.resolveRoot).toBe("function");
    expect(typeof trajectory.enrichment.buildFileSignals).toBe("function");
  });
});
```

### Step 2: Run test to verify it fails

Expected: FAIL — module not found

### Step 3: Implement

Add `Trajectory` to `contracts/types/trajectory.ts`:

```typescript
import type { EnrichmentProvider, FilterDescriptor } from "./provider.js";
import type { DerivedSignalDescriptor, RerankPreset } from "./reranker.js";

export interface Trajectory {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  // Query-side
  readonly payloadSignals: PayloadSignalDescriptor[];
  readonly derivedSignals: DerivedSignalDescriptor[];
  readonly filters: FilterDescriptor[];
  readonly presets: RerankPreset[];
  // Ingest-side (ISP)
  readonly enrichment: EnrichmentProvider;
}
```

Create `src/core/trajectory/git.ts`:

```typescript
import type { Trajectory } from "../contracts/types/trajectory.js";
import { gitFilters } from "./git/filters.js";
import { GitEnrichmentProvider } from "./git/provider.js";
import { gitDerivedSignals } from "./git/rerank/derived-signals/index.js";
import { GIT_PRESETS } from "./git/rerank/presets/index.js";
import { gitPayloadSignalDescriptors } from "./git/signals.js";

export class GitTrajectory implements Trajectory {
  readonly key = "git";
  readonly name = "Git";
  readonly description =
    "Git history signals: churn, authorship, age, and derived analytics";
  readonly payloadSignals = gitPayloadSignalDescriptors;
  readonly derivedSignals = gitDerivedSignals;
  readonly filters = gitFilters;
  readonly presets = GIT_PRESETS;
  readonly enrichment = new GitEnrichmentProvider();
}
```

Trim `GitEnrichmentProvider` to ingest-only (remove signals, derivedSignals,
filters, presets fields).

### Step 4: Run verification

Run: `npx tsc --noEmit && npx vitest run` Expected: 0 errors, all tests pass

### Step 5: Commit

```bash
git commit -m "feat(trajectory): add Trajectory interface and GitTrajectory entry point"
```

---

## Task 9: Move TrajectoryRegistry to trajectory/index.ts

**Files:**

- Move: `src/core/contracts/trajectory-registry.ts` →
  `src/core/trajectory/index.ts`
- Modify: `src/core/contracts/index.ts` (remove re-export, add back via
  trajectory)
- Update: registry to use `Trajectory` interface instead of `EnrichmentProvider`
- Test: `tests/core/trajectory/trajectory-registry.test.ts` (move + update)

### Step 1: Write failing test

```typescript
// tests/core/trajectory/trajectory-registry.test.ts
import { describe, expect, it } from "vitest";

import { GitTrajectory } from "../../../src/core/trajectory/git.js";
import { TrajectoryRegistry } from "../../../src/core/trajectory/index.js";

describe("TrajectoryRegistry with Trajectory interface", () => {
  it("registers a Trajectory and aggregates payloadSignals", () => {
    const registry = new TrajectoryRegistry();
    registry.register(new GitTrajectory());
    expect(registry.getAllPayloadSignalDescriptors().length).toBeGreaterThan(0);
  });

  it("aggregates derivedSignals from trajectories", () => {
    const registry = new TrajectoryRegistry();
    registry.register(new GitTrajectory());
    expect(registry.getAllDerivedSignals().length).toBeGreaterThan(0);
  });

  it("aggregates filters from trajectories", () => {
    const registry = new TrajectoryRegistry();
    registry.register(new GitTrajectory());
    expect(registry.getAllFilters().length).toBeGreaterThan(0);
  });

  it("gets enrichment providers for ingest", () => {
    const registry = new TrajectoryRegistry();
    registry.register(new GitTrajectory());
    const providers = registry.getAllEnrichmentProviders();
    expect(providers).toHaveLength(1);
    expect(typeof providers[0].buildFileSignals).toBe("function");
  });
});
```

### Step 2: Run test to verify it fails

Expected: FAIL — import path change, new methods

### Step 3: Implement

Move + update `TrajectoryRegistry` to accept `Trajectory` instead of
`EnrichmentProvider`:

```typescript
// src/core/trajectory/index.ts
import type {
  PayloadSignalDescriptor,
  Trajectory,
} from "../contracts/types/trajectory.js";

// ... other imports

export class TrajectoryRegistry {
  private readonly trajectories: Map<string, Trajectory> = new Map();

  register(trajectory: Trajectory): void {
    /* ... */
  }
  getAllPayloadSignalDescriptors(): PayloadSignalDescriptor[] {
    /* aggregate from all trajectories */
  }
  getAllDerivedSignals(): DerivedSignalDescriptor[] {
    /* ... */
  }
  getAllFilters(): FilterDescriptor[] {
    /* ... */
  }
  getAllPresets(): RerankPreset[] {
    /* ... */
  }
  getAllEnrichmentProviders(): EnrichmentProvider[] {
    /* trajectory.enrichment from each */
  }
  buildFilter(params, level = "chunk") {
    /* ... */
  }
}
```

### Step 4: Update imports across codebase

All files that imported `TrajectoryRegistry` from `contracts/` now import from
`trajectory/`.

### Step 5: Run verification

Run: `npx tsc --noEmit && npx vitest run` Expected: 0 errors, all tests pass

### Step 6: Commit

```bash
git commit -m "refactor(trajectory): move TrajectoryRegistry to trajectory/index.ts, use Trajectory interface"
```

---

## Task 10: Search-module delegates filters to registry

**Bead:** `tea-rags-mcp-7w4`

**Files:**

- Modify: `src/core/search/search-module.ts`
- Modify: `tests/core/search/search-module.test.ts`

### Step 1: Write failing test

```typescript
// Test that SearchModule uses registry-built filters instead of inline hardcode
it("delegates git filters to registry.buildFilter()", () => {
  // ... test that passing author/minAgeDays/etc. produces correct Qdrant filter
  // via the registry path, not hardcoded keys
});
```

### Step 2: Run test to verify it fails

### Step 3: Replace hardcoded filter blocks

In `searchCode()`, replace ~50 lines of if/push blocks (lines 78-128) with:

```typescript
// Build trajectory filters via registry
const trajectoryFilter = this.registry?.buildFilter(
  {
    author: options?.author,
    modifiedAfter: options?.modifiedAfter,
    modifiedBefore: options?.modifiedBefore,
    minAgeDays: options?.minAgeDays,
    maxAgeDays: options?.maxAgeDays,
    minCommitCount: options?.minCommitCount,
    taskId: options?.taskId,
  },
  "chunk",
);
if (trajectoryFilter?.must) {
  mustConditions.push(...trajectoryFilter.must);
}
```

Add `registry` to SearchModule constructor or inject via SearchFacade.

### Step 4: Run verification

Run: `npx tsc --noEmit && npx vitest run` Expected: 0 errors, all tests pass

### Step 5: Commit

```bash
git commit -m "refactor(search): delegate git filters to TrajectoryRegistry.buildFilter()"
```

---

## Task 11: Wire TrajectoryRegistry in composition root

**Bead:** `tea-rags-mcp-w07`

**Files:**

- Create: `src/core/api/composition.ts`
- Modify: `src/bootstrap/factory.ts` (thin — delegates to composition)
- Modify: `src/core/api/search-facade.ts` (if needed, to accept registry)
- Test: `tests/core/api/composition.test.ts`

### Step 1: Write failing test

```typescript
describe("createComposition", () => {
  it("builds registry with GitTrajectory", () => {
    const { registry, reranker, allPayloadSignalDescriptors } =
      createComposition();
    expect(registry.has("git")).toBe(true);
    expect(allPayloadSignalDescriptors.length).toBeGreaterThan(0);
  });
});
```

### Step 2: Run test to verify it fails

### Step 3: Implement composition.ts

```typescript
// src/core/api/composition.ts
import { BASE_PAYLOAD_SIGNALS } from "../contracts/payload-signals.js";
import { structuralSignals } from "../search/rerank/derived-signals/index.js";
import {
  RELEVANCE_PRESETS,
  resolvePresets,
} from "../search/rerank/presets/index.js";
import { Reranker } from "../search/reranker.js";
import { GitTrajectory } from "../trajectory/git.js";
import { TrajectoryRegistry } from "../trajectory/index.js";

export function createComposition() {
  const registry = new TrajectoryRegistry();
  registry.register(new GitTrajectory());

  const allPayloadSignalDescriptors = [
    ...BASE_PAYLOAD_SIGNALS,
    ...registry.getAllPayloadSignalDescriptors(),
  ];
  const allDerivedSignals = [
    ...registry.getAllDerivedSignals(),
    ...structuralSignals,
  ];
  const resolvedPresets = resolvePresets(
    RELEVANCE_PRESETS,
    registry.getAllPresets(),
    [],
  );
  const reranker = new Reranker(
    allDerivedSignals,
    resolvedPresets,
    allPayloadSignalDescriptors,
  );

  return {
    registry,
    reranker,
    allPayloadSignalDescriptors,
    allDerivedSignals,
    resolvedPresets,
  };
}
```

Thin out `factory.ts`:

```typescript
export function createAppContext(config: AppConfig): AppContext {
  const qdrant = new QdrantManager(config.qdrantUrl, config.qdrantApiKey);
  const embeddings = EmbeddingProviderFactory.createFromEnv();
  const { registry, reranker } = createComposition();
  const schemaBuilder = new SchemaBuilder(reranker);
  const ingest = new IngestFacade(qdrant, embeddings, config.code);
  const search = new SearchFacade(qdrant, embeddings, config.code, reranker);
  return { qdrant, embeddings, ingest, search, reranker, schemaBuilder };
}
```

### Step 4: Run verification

Run: `npx tsc --noEmit && npx vitest run`

### Step 5: Commit

```bash
git commit -m "feat(api): add composition root, wire TrajectoryRegistry"
```

---

## Task 12: computeCollectionStats() generic function

**Files:**

- Add to: `src/core/api/composition.ts` (or separate file)
- Test: `tests/core/api/collection-stats.test.ts`

### Step 1: Write failing test

```typescript
describe("computeCollectionStats", () => {
  it("computes percentile stats for all numeric PayloadSignalDescriptors", async () => {
    const mockQdrant = {
      /* scroll mock returning payload points */
    };
    const signals: PayloadSignalDescriptor[] = [
      { key: "git.file.commitCount", type: "number", description: "commits" },
      { key: "git.file.ageDays", type: "number", description: "age" },
    ];
    const stats = await computeCollectionStats(
      mockQdrant,
      "test-collection",
      signals,
    );
    expect(stats.perSignal.has("git.file.commitCount")).toBe(true);
    expect(stats.perSignal.has("git.file.ageDays")).toBe(true);
    expect(stats.computedAt).toBeGreaterThan(0);
  });
});
```

### Step 2: Run test to verify it fails

### Step 3: Implement

Generic — receives `PayloadSignalDescriptor[]` from registry, scrolls Qdrant
collection, computes `SignalStats` for all `type: "number"` signals. Uses
`readPayloadPath()` for dot-notation. Returns `CollectionSignalStats`.

### Step 4: Run verification

Run: `npx tsc --noEmit && npx vitest run`

### Step 5: Commit

```bash
git commit -m "feat(api): add generic computeCollectionStats() for adaptive thresholds"
```

---

## Task 13: Delete Signal interface + cleanup

**Bead:** Close `tea-rags-mcp-462`, `tea-rags-mcp-7w4`, `tea-rags-mcp-w07`

**Files:**

- Modify: `src/core/contracts/types/provider.ts` (remove `Signal` interface)
- Modify: `src/core/contracts/index.ts` (remove `Signal` re-export)
- Delete: `src/core/contracts/trajectory-registry.ts` (moved to trajectory/)
- Modify: `CLAUDE.md` (update project structure)
- Modify: All files importing `Signal` type

### Step 1: Remove `Signal` from provider.ts

Keep `EnrichmentProvider` but without `signals: Signal[]` (already removed in
Task 8).

### Step 2: Find and fix all remaining `Signal` imports

Use grep to find any remaining references to the old `Signal` type.

### Step 3: Update CLAUDE.md project structure section

Reflect new files: `trajectory.ts` types, `trajectory/index.ts`,
`trajectory/git.ts`, `api/composition.ts`, `contracts/payload-signals.ts`.

### Step 4: Run verification

Run: `npx tsc --noEmit && npx vitest run` Expected: 0 errors, all tests pass

### Step 5: Commit

```bash
git commit -m "refactor: delete Signal interface, cleanup dead code, update CLAUDE.md"
```

### Step 6: Close beads

```bash
bd close tea-rags-mcp-462 tea-rags-mcp-7w4 tea-rags-mcp-w07
bd sync
```

---

## Final Verification

1. `npx tsc --noEmit` — 0 errors
2. `npx vitest run` — all tests pass
3. `npx eslint .` — 0 errors
4. Domain boundary check — no `search/ → trajectory/` or `trajectory/ → search/`
   imports
5. No `CONFIDENCE_THRESHOLDS`, `signalConfidence`,
   `getEffectiveConfidenceValue`, or `readRawSource` with git namespace
   knowledge in reranker.ts
6. All filter keys use `git.file.*` or `git.${level}.*` (no flat `git.ageDays`)
7. `TrajectoryRegistry` lives in `trajectory/index.ts`, not `contracts/`
