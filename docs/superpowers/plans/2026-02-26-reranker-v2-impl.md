# Reranker v2: Signal Taxonomy, Ranking Overlay, Schema Generation

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to
> implement this plan task-by-task.

**Goal:** Decompose monolithic `reranker.ts` (617 lines) with proper signal
taxonomy (raw vs derived), metadata overlay in reranker responses, and
auto-generated MCP schemas. Replaces
`docs/plans/2026-02-26-reranker-decomposition-impl.md` (architecturally
rejected).

**Architecture:**

- **Signal** = raw payload field (ageDays, commitCount). Stored in Qdrant.
- **Derived Signal** = normalized transform of raw signals (recency, churn,
  ownership). Computed at rerank time.
- **Structural Signal** = derived signal from payload structure, not from
  providers (similarity, chunkSize, documentation).
- Provider defines both raw signals (`Signal[]`) and derived signals
  (`DerivedSignalDescriptor[]`).
- Reranker reads derived signals from providers via registry, adds structural
  signals, computes adaptive bounds, scores via preset weights, attaches ranking
  overlay.
- Ranking overlay = subset of raw + derived signals relevant to the preset, at
  both file and chunk levels.
- `NormalizationBounds` monolith eliminated — replaced by
  `signal.defaultBound` + adaptive p95.
- `ScoringWeightsSchema` auto-generated from registered signal descriptors.

**Tech Stack:** TypeScript, Vitest

**Prerequisites:** Plan A (Domain Boundaries) complete (ed97b04). All scoring
improvements preserved: L3 alpha-blending, per-signal quadratic confidence,
adaptive bounds, Laplace smoothing, continuous blockPenalty.

**Supersedes:** `2026-02-26-reranker-decomposition-impl.md` (old plan with
GitReranker/GenericReranker/CompositeReranker — wrong abstraction).

---

## Phase 0: Clean Slate

### Task 1: Revert uncommitted Plan B code

All Plan B uncommitted changes are architecturally wrong. Revert to `ed97b04`
committed state.

**Files:**

- Revert: `src/core/contracts/types/reranker.ts` (remove TrajectoryReranker
  interface)
- Revert: `src/core/search/reranker.ts` (restore 617-line monolith)
- Revert: `src/core/search/search-module.ts` (restore original imports)
- Revert: `src/mcp/tools/formatters/search-pipeline.ts` (restore original
  imports)
- Delete: `src/core/search/composite-reranker.ts`
- Delete: `src/core/search/generic-reranker.ts`
- Delete: `src/core/search/git-reranker.ts`
- Delete: `src/core/trajectory/git/reranker.ts`
- Delete: `tests/core/search/composite-reranker.test.ts`
- Delete: `tests/core/search/generic-reranker.test.ts`
- Delete: `tests/core/search/git-reranker.test.ts`

**Step 1: Revert modified files**

```bash
git checkout -- src/core/contracts/types/reranker.ts src/core/search/reranker.ts src/core/search/search-module.ts src/mcp/tools/formatters/search-pipeline.ts
```

**Step 2: Delete wrong files**

```bash
rm -f src/core/search/composite-reranker.ts src/core/search/generic-reranker.ts src/core/search/git-reranker.ts src/core/trajectory/git/reranker.ts
rm -f tests/core/search/composite-reranker.test.ts tests/core/search/generic-reranker.test.ts tests/core/search/git-reranker.test.ts
```

**Step 3: Verify clean state**

Run: `npx tsc --noEmit && npx vitest run` Expected: ALL PASS (monolith still
intact)

**Step 4: Commit**

```bash
git add -A
git commit -m "revert: remove wrong Plan B decomposition, restore monolithic reranker"
```

---

## Phase 1: DerivedSignalDescriptor in Contracts

### Task 2: Write DerivedSignalDescriptor tests

**Files:**

- Create: `tests/core/trajectory/git/signals.test.ts`

**Step 1: Write failing tests**

```typescript
import { describe, expect, it } from "vitest";

import { gitDerivedSignals } from "../../../../src/core/trajectory/git/signals.js";

describe("gitDerivedSignals", () => {
  const fakePayload = (git?: Record<string, unknown>) =>
    ({ relativePath: "a.ts", startLine: 1, endLine: 50, git }) as Record<
      string,
      unknown
    >;

  it("has 14 derived signal descriptors", () => {
    expect(gitDerivedSignals).toHaveLength(14);
  });

  it("every descriptor has name, description, non-empty sources, and extract function", () => {
    for (const d of gitDerivedSignals) {
      expect(d.name).toBeTruthy();
      expect(d.description).toBeTruthy();
      expect(d.sources.length).toBeGreaterThan(0);
      expect(typeof d.extract).toBe("function");
    }
  });

  it("extract returns 0-1 for all descriptors given valid data", () => {
    const payload = fakePayload({
      file: {
        ageDays: 100,
        commitCount: 10,
        bugFixRate: 30,
        dominantAuthorPct: 80,
        churnVolatility: 20,
        changeDensity: 8,
        relativeChurn: 2.0,
        recencyWeightedFreq: 5,
        contributorCount: 2,
      },
      chunk: { commitCount: 5, churnRatio: 0.3 },
    });
    for (const d of gitDerivedSignals) {
      const val = d.extract(payload);
      expect(val).toBeGreaterThanOrEqual(0);
      expect(val).toBeLessThanOrEqual(1);
    }
  });

  it("extract returns 0 for empty payload (no git data)", () => {
    const payload = fakePayload();
    for (const d of gitDerivedSignals) {
      const val = d.extract(payload);
      expect(val).toBeGreaterThanOrEqual(0);
      expect(val).toBeLessThanOrEqual(1);
    }
  });

  describe("individual signals", () => {
    it("recency: 1 - ageDays/365", () => {
      const d = gitDerivedSignals.find((s) => s.name === "recency")!;
      expect(d.sources).toContain("ageDays");
      const val = d.extract(fakePayload({ file: { ageDays: 182.5 } }));
      expect(val).toBeCloseTo(0.5, 2);
    });

    it("ownership: from dominantAuthorPct", () => {
      const d = gitDerivedSignals.find((s) => s.name === "ownership")!;
      expect(d.sources).toContain("dominantAuthorPct");
      expect(d.sources).toContain("authors");
      const val = d.extract(fakePayload({ file: { dominantAuthorPct: 80 } }));
      expect(val).toBeCloseTo(0.8, 2);
    });

    it("knowledgeSilo: categorical from contributorCount", () => {
      const d = gitDerivedSignals.find((s) => s.name === "knowledgeSilo")!;
      expect(
        d.extract(fakePayload({ file: { contributorCount: 1 } })),
      ).toBeCloseTo(1.0);
      expect(
        d.extract(fakePayload({ file: { contributorCount: 2 } })),
      ).toBeCloseTo(0.5);
      expect(d.extract(fakePayload({ file: { contributorCount: 5 } }))).toBe(0);
    });

    it("blockPenalty: 1 for block without chunk data, 0 for non-block", () => {
      const d = gitDerivedSignals.find((s) => s.name === "blockPenalty")!;
      expect(
        d.extract({
          ...fakePayload({ file: { commitCount: 10 } }),
          chunkType: "block",
        }),
      ).toBeCloseTo(1.0);
      expect(
        d.extract({
          ...fakePayload({ file: { commitCount: 10 } }),
          chunkType: "function",
        }),
      ).toBe(0);
    });
  });
});
```

**Step 2: Run to verify failure**

Run: `npx vitest run tests/core/trajectory/git/signals.test.ts` Expected: FAIL —
`gitDerivedSignals` export not found (currently exported as `gitSignals`)

---

### Task 3: Add `sources` to signal descriptors + export as DerivedSignalDescriptor

**Files:**

- Modify: `src/core/trajectory/git/signals.ts` — add `sources` to each
  descriptor, rename export
- Modify: `src/core/contracts/types/reranker.ts` — add `DerivedSignalDescriptor`
  type

**Step 1: Add DerivedSignalDescriptor to contracts**

In `src/core/contracts/types/reranker.ts`, add:

```typescript
/**
 * Derived signal descriptor — defines how to compute a normalized signal
 * from raw payload data. Used by reranker for scoring and ranking overlay.
 */
export interface DerivedSignalDescriptor {
  /** Derived signal name (weight key in presets) */
  name: string;
  /** Human-readable description */
  description: string;
  /** Raw signal names this derived signal reads from (enables ranking overlay) */
  sources: string[];
  /** Extract normalized value (0-1) from search result payload */
  extract: (payload: Record<string, unknown>) => number;
  /** Default upper bound for normalization */
  defaultBound?: number;
  /** Whether to apply confidence dampening */
  needsConfidence?: boolean;
  /** Which raw signal field for confidence threshold (default: "commitCount") */
  confidenceField?: string;
}
```

**Step 2: Update signals.ts — add sources to each descriptor**

Change interface from local `SignalDescriptor` to import
`DerivedSignalDescriptor` from contracts. Add `sources: string[]` to each of the
14 descriptors:

| Derived Signal     | sources                                |
| ------------------ | -------------------------------------- |
| recency            | `["ageDays"]`                          |
| stability          | `["commitCount"]`                      |
| churn              | `["commitCount"]`                      |
| age                | `["ageDays"]`                          |
| ownership          | `["dominantAuthorPct", "authors"]`     |
| bugFix             | `["bugFixRate"]`                       |
| volatility         | `["churnVolatility"]`                  |
| density            | `["changeDensity"]`                    |
| chunkChurn         | `["chunk.commitCount"]`                |
| relativeChurnNorm  | `["relativeChurn"]`                    |
| burstActivity      | `["recencyWeightedFreq"]`              |
| knowledgeSilo      | `["contributorCount"]`                 |
| chunkRelativeChurn | `["chunk.churnRatio"]`                 |
| blockPenalty       | `["chunk.commitCount", "commitCount"]` |

Rename export: `gitSignals` → `gitDerivedSignals` (clarity: these are derived,
not raw).

**Step 3: Run tests**

Run: `npx vitest run tests/core/trajectory/git/signals.test.ts` Expected: PASS

**Step 4: Run full test suite**

Run: `npx tsc --noEmit && npx vitest run` Expected: ALL PASS (update any imports
of old `gitSignals` name)

**Step 5: Commit**

```bash
git add src/core/contracts/types/reranker.ts src/core/trajectory/git/signals.ts tests/core/trajectory/git/signals.test.ts
git commit -m "feat(contracts): DerivedSignalDescriptor type, add sources to git signal descriptors"
```

---

## Phase 2: Structural Signal Descriptors

### Task 4: Write structural signal descriptor tests

**Files:**

- Create: `tests/core/search/structural-signals.test.ts`

Test the 5 structural signals: `similarity`, `chunkSize`, `documentation`,
`imports`, `pathRisk`.

```typescript
import { describe, expect, it } from "vitest";

import { structuralSignals } from "../../../src/core/search/structural-signals.js";

describe("structuralSignals", () => {
  it("has 5 descriptors", () => {
    expect(structuralSignals).toHaveLength(5);
  });

  it("similarity returns the original score", () => {
    const d = structuralSignals.find((s) => s.name === "similarity")!;
    expect(d.extract({ _score: 0.85 })).toBe(0.85);
  });

  it("chunkSize normalizes line range", () => {
    const d = structuralSignals.find((s) => s.name === "chunkSize")!;
    expect(d.extract({ startLine: 10, endLine: 110, _score: 0 })).toBeCloseTo(
      0.2,
      2,
    );
  });

  it("documentation returns 1 for docs", () => {
    const d = structuralSignals.find((s) => s.name === "documentation")!;
    expect(d.extract({ isDocumentation: true, _score: 0 })).toBe(1);
    expect(d.extract({ isDocumentation: false, _score: 0 })).toBe(0);
  });

  it("imports normalizes import count", () => {
    const d = structuralSignals.find((s) => s.name === "imports")!;
    expect(
      d.extract({ imports: ["a", "b", "c", "d", "e"], _score: 0 }),
    ).toBeCloseTo(0.25, 2);
  });

  it("pathRisk detects security patterns", () => {
    const d = structuralSignals.find((s) => s.name === "pathRisk")!;
    expect(d.extract({ relativePath: "src/auth/login.ts", _score: 0 })).toBe(1);
    expect(d.extract({ relativePath: "src/utils/math.ts", _score: 0 })).toBe(0);
  });

  it("every descriptor has empty sources (structural, no raw signal dependency)", () => {
    for (const d of structuralSignals) {
      expect(d.sources).toEqual([]);
    }
  });
});
```

Run: `npx vitest run tests/core/search/structural-signals.test.ts` Expected:
FAIL — module not found

---

### Task 5: Implement structural signal descriptors

**Files:**

- Create: `src/core/search/structural-signals.ts`

```typescript
import type { DerivedSignalDescriptor } from "../contracts/types/reranker.js";

function normalize(value: number, max: number): number {
  if (max <= 0) return 0;
  return Math.min(1, Math.max(0, value / max));
}

const RISKY_PATH_PATTERNS = [
  "auth",
  "security",
  "crypto",
  "password",
  "secret",
  "token",
  "credential",
  "permission",
  "access",
];

export const structuralSignals: DerivedSignalDescriptor[] = [
  {
    name: "similarity",
    description: "Base semantic similarity score from vector search",
    sources: [],
    extract(payload) {
      return (payload._score as number) ?? 0;
    },
  },
  {
    name: "chunkSize",
    description: "Normalized chunk size (endLine - startLine)",
    sources: [],
    defaultBound: 500,
    extract(payload) {
      const start = (payload.startLine as number) || 0;
      const end = (payload.endLine as number) || 0;
      return normalize(Math.max(0, end - start), 500);
    },
  },
  {
    name: "documentation",
    description: "Documentation file boost (1 if isDocumentation, 0 otherwise)",
    sources: [],
    extract(payload) {
      return payload.isDocumentation ? 1 : 0;
    },
  },
  {
    name: "imports",
    description: "Normalized import/dependency count",
    sources: [],
    defaultBound: 20,
    extract(payload) {
      const arr = payload.imports;
      return normalize(Array.isArray(arr) ? arr.length : 0, 20);
    },
  },
  {
    name: "pathRisk",
    description:
      "Security-sensitive path pattern match (1 if matches, 0 otherwise)",
    sources: [],
    extract(payload) {
      const path = ((payload.relativePath as string) || "").toLowerCase();
      return RISKY_PATH_PATTERNS.some((p) => path.includes(p)) ? 1 : 0;
    },
  },
];
```

Run: `npx vitest run tests/core/search/structural-signals.test.ts` Expected:
PASS

**Commit:**

```bash
git add src/core/search/structural-signals.ts tests/core/search/structural-signals.test.ts
git commit -m "feat(search): structural signal descriptors (similarity, chunkSize, docs, imports, pathRisk)"
```

---

## Phase 3: Provider exposes derived signals

### Task 6: Add derivedSignals to EnrichmentProvider interface

**Files:**

- Modify: `src/core/contracts/types/provider.ts` — add `derivedSignals` field
- Modify: `src/core/trajectory/git/provider.ts` — expose gitDerivedSignals

**Step 1: Update EnrichmentProvider interface**

In `src/core/contracts/types/provider.ts`, add to the query-side contract:

```typescript
import type { DerivedSignalDescriptor } from "./reranker.js";

export interface EnrichmentProvider {
  // ... existing ...

  // ── Query-side contract ──

  readonly signals: Signal[];
  readonly derivedSignals: DerivedSignalDescriptor[]; // NEW
  readonly filters: FilterDescriptor[];
  readonly presets: Record<string, ScoringWeights>;

  // ... rest unchanged ...
}
```

**Step 2: Implement in GitEnrichmentProvider**

In `src/core/trajectory/git/provider.ts`:

```typescript
import { gitDerivedSignals } from "./signals.js";

export class GitEnrichmentProvider implements EnrichmentProvider {
  // ... existing ...
  readonly derivedSignals: DerivedSignalDescriptor[] = gitDerivedSignals;
}
```

**Step 3: Run all tests**

Run: `npx tsc --noEmit && npx vitest run` Expected: ALL PASS

**Step 4: Commit**

```bash
git add src/core/contracts/types/provider.ts src/core/trajectory/git/provider.ts
git commit -m "feat(contracts): add derivedSignals to EnrichmentProvider, wire in git provider"
```

---

## Phase 4: Reranker with Ranking Overlay

### Task 7: Define RankingOverlay type

**Files:**

- Modify: `src/core/contracts/types/reranker.ts` — add RankingOverlay,
  RerankedResult types

```typescript
/** Raw signal values relevant to the active preset, at file and chunk levels. */
export interface RankingOverlayRaw {
  file?: Record<string, unknown>;
  chunk?: Record<string, unknown>;
}

/** Ranking overlay attached to each reranked result — explains WHY it scored this way. */
export interface RankingOverlay {
  preset: string;
  derived: Record<string, number>;
  raw: layRaw;
}

/** Search result with optional ranking overlay. */
export interface RerankedResult extends RerankableResult {
  rankingOverlay?: lay;
}
```

**Commit:**

```bash
git add src/core/contracts/types/reranker.ts
git commit -m "feat(contracts): RankingOverlay and RerankedResult types"
```

---

### Task 8: Write Reranker tests

**Files:**

- Modify: `tests/core/search/reranker.test.ts` — add tests for new Reranker
  class

Add a NEW describe block for the new `Reranker` class (keep existing tests for
backward compat facade):

```typescript
import { Reranker } from "../../../src/core/search/reranker.js";
import { gitDerivedSignals } from "../../../src/core/trajectory/git/signals.js";
import { structuralSignals } from "../../../src/core/search/structural-signals.js";

describe("Reranker (v2)", () => {
  const reranker = new Reranker(gitDerivedSignals, structuralSignals);

  it("returns results unchanged for relevance preset", () => { ... });

  it("reranks by techDebt preset", () => { ... });

  it("attaches rankingOverlay with relevant raw + derived signals", () => {
    const results = [
      makeResult(0.9, { file: { ageDays: 200, commitCount: 30 } }),
    ];
    const ranked = reranker.rerank(results, "techDebt", "semantic_search");
    expect(ranked[0].rankingOverlay).toBeDefined();
    expect(ranked[0].rankingOverlay!.preset).toBe("techDebt");
    // techDebt uses age, churn, bugFix, etc. — raw overlay has relevant fields
    expect(ranked[0].rankingOverlay!.raw.file).toHaveProperty("ageDays");
    expect(ranked[0].rankingOverlay!.raw.file).toHaveProperty("commitCount");
    // derived values present
    expect(ranked[0].rankingOverlay!.derived).toHaveProperty("age");
    expect(ranked[0].rankingOverlay!.derived).toHaveProperty("churn");
  });

  it("overlay includes both file and chunk raw signals when chunk data exists", () => {
    const results = [
      makeResult(0.8, { file: { ageDays: 100, commitCount: 20 }, chunk: { commitCount: 5 } }),
    ];
    const ranked = reranker.rerank(results, "hotspots", "semantic_search");
    expect(ranked[0].rankingOverlay!.raw.file).toBeDefined();
    expect(ranked[0].rankingOverlay!.raw.chunk).toBeDefined();
    expect(ranked[0].rankingOverlay!.raw.chunk).toHaveProperty("commitCount");
  });

  it("overlay only includes signals used by the preset", () => {
    const results = [makeResult(0.9, { file: { ageDays: 100, commitCount: 20, bugFixRate: 10 } })];
    const ranked = reranker.rerank(results, "impactAnalysis", "semantic_search");
    // impactAnalysis uses only similarity + imports — no git raw signals in overlay
    expect(ranked[0].rankingOverlay!.derived).not.toHaveProperty("age");
    expect(ranked[0].rankingOverlay!.derived).not.toHaveProperty("churn");
  });

  it("computes adaptive bounds from result batch", () => { ... });

  it("handles empty results", () => { ... });

  it("supports custom weights", () => { ... });
});
```

Run: `npx vitest run tests/core/search/reranker.test.ts` Expected: FAIL —
`Reranker` class not found

---

### Task 9: Implement Reranker class

**Files:**

- Modify: `src/core/search/reranker.ts` — replace monolith with new Reranker
  class

The new `Reranker` class:

1. Accepts `DerivedSignalDescriptor[]` (from providers) +
   `DerivedSignalDescriptor[]` (structural) via constructor
2. `rerank(results, mode, presetSet)` → `RerankedResult[]` with ranking overlay
3. Scoring: per-signal adaptive bounds (p95 from batch, floored with
   `descriptor.defaultBound`), then weighted sum
4. Overlay: for each preset weight key, find the descriptor → get `sources` →
   extract raw values from payload at file/chunk levels
5. Confidence dampening: quadratic per-signal, using descriptor's
   `needsConfidence` + `confidenceField`

Key methods:

- `rerank(results, mode, presetSet)` — main entry point
- `private computeAdaptiveBounds(results, descriptors)` — p95 per descriptor
  name, floored with defaultBound
- `private extractAllDerived(payload, bounds)` — call each descriptor.extract(),
  apply confidence
- `private buildOverlay(payload, presetWeights, derivedValues)` — build
  RankingOverlay
- `private calculateScore(signals, weights)` — weighted sum

Preserves ALL existing scoring behavior:

- L3 alpha-blending (in git derived signal extract() functions)
- Per-signal quadratic confidence dampening
- Adaptive bounds with p95 + floor
- Continuous blockPenalty via dataQualityDiscount

Keep backward-compatible facade functions (`rerankResults`,
`rerankSemanticSearchResults`, etc.) that delegate to new `Reranker`.

**Step 1: Implement**

**Step 2: Run tests**

Run: `npx tsc --noEmit && npx vitest run` Expected: ALL PASS (both new and
existing backward-compat tests)

**Step 3: Commit**

```bash
git add src/core/search/reranker.ts tests/core/search/reranker.test.ts
git commit -m "feat(search): Reranker v2 with ranking overlay, adaptive bounds, descriptor-based scoring"
```

---

## Phase 5: Kill NormalizationBounds Monolith

### Task 10: Replace NormalizationBounds with dynamic bounds

**Files:**

- Modify: `src/core/contracts/types/reranker.ts` — deprecate NormalizationBounds
- Modify: `src/core/search/reranker.ts` — use descriptor.defaultBound for floor

The monolithic `NormalizationBounds` interface with 11 hardcoded fields is
replaced by:

- Each `DerivedSignalDescriptor` has `defaultBound` (already exists in
  signals.ts)
- Adaptive bounds: `Map<string, number>` computed from `p95(resultBatch)` per
  signal name
- Floor: `Math.max(adaptive, descriptor.defaultBound ?? 1)`

Remove `NormalizationBounds` from contracts. Update any remaining consumers.

Run: `npx tsc --noEmit && npx vitest run` Expected: ALL PASS

**Commit:**

```bash
git add -A
git commit -m "refactor: replace NormalizationBounds monolith with per-descriptor defaultBound"
```

---

## Phase 6: Wire into Consumers

### Task 11: Wire Reranker into search-module and search-pipeline

**Files:**

- Modify: `src/core/search/search-module.ts` — use new Reranker
- Modify: `src/mcp/tools/formatters/search-pipeline.ts` — use new Reranker
- Modify: `src/mcp/tools/search.ts` — pass overlay through to response

The reranker now needs `DerivedSignalDescriptor[]` from providers. Two wiring
approaches:

**Option A (simple):** Construct Reranker with `gitDerivedSignals` +
`structuralSignals` directly (temporary, until full registry integration).

**Option B (registry):** Get descriptors from TrajectoryRegistry. Requires
`TrajectoryRegistry.getAllDerivedSignals()`.

Start with Option A. Registry integration follows in Task 12.

**Important:** `formatSearchResults` in `search-pipeline.ts` must include
`rankingOverlay` in the response when present.

Run: `npx tsc --noEmit && npx vitest run` Expected: ALL PASS

**Commit:**

```bash
git add -A
git commit -m "feat(search): wire Reranker v2 into search-module and MCP search pipeline"
```

---

### Task 12: Registry integration — getAllDerivedSignals

**Files:**

- Modify: `src/core/contracts/trajectory-registry.ts` — add
  `getAllDerivedSignals()` method
- Modify: wiring code — construct Reranker via registry descriptors

`TrajectoryRegistry.getAllDerivedSignals()` aggregates `provider.derivedSignals`
from all registered providers. Validates uniqueness: two providers CANNOT define
a derived signal with the same name (throws on registration).

Run: `npx tsc --noEmit && npx vitest run` Expected: ALL PASS

**Commit:**

```bash
git add -A
git commit -m "feat(contracts): TrajectoryRegistry.getAllDerivedSignals(), wire into Reranker"
```

---

## Phase 7: Auto-Generate ScoringWeightsSchema

### Task 13: Generate ScoringWeightsSchema from descriptors

**Files:**

- Modify: `src/mcp/tools/schemas.ts` — generate `ScoringWeightsSchema` from
  signal descriptors

Replace the manually maintained Zod schema:

```typescript
// NEW: generated from descriptors
import { structuralSignals } from "../../core/search/structural-signals.js";
import { gitDerivedSignals } from "../../core/trajectory/git/signals.js";

// OLD: 18 manually listed fields
const ScoringWeightsSchema = z.object({
  similarity: z.number().optional(),
  recency: z.number().optional(),
  // ... 16 more
});

function buildScoringWeightsSchema(descriptors: DerivedSignalDescriptor[]) {
  const shape: Record<string, z.ZodOptional<z.ZodNumber>> = {};
  for (const d of descriptors) {
    shape[d.name] = z.number().optional();
  }
  return z.object(shape);
}

const ScoringWeightsSchema = buildScoringWeightsSchema([
  ...structuralSignals,
  ...gitDerivedSignals,
]);
```

Adding a new derived signal automatically updates the MCP API schema.

Run: `npx tsc --noEmit && npx vitest run` Expected: ALL PASS

**Commit:**

```bash
git add src/mcp/tools/schemas.ts
git commit -m "feat(mcp): auto-generate ScoringWeightsSchema from signal descriptors"
```

---

## Phase 8: Cleanup

### Task 14: Close old beads tasks, create new tracking

Close outdated beads tasks from old plan:

- `tea-rags-mcp-0az` (GitReranker — replaced by descriptor-based approach)
- `tea-rags-mcp-bk5` (GenericReranker — replaced by structural descriptors)
- `tea-rags-mcp-6ra` (CompositeReranker — replaced by Reranker v2)
- `tea-rags-mcp-e07` (Wire CompositeReranker — replaced by Task 11)
- `tea-rags-mcp-2rb` (PresetRegistry — replaced by registry integration)
- `tea-rags-mcp-cfg` (Deprecate monolith — monolith replaced by Reranker v2)
- `tea-rags-mcp-01b` (TrajectoryReranker interface — wrong abstraction, removed)

### Task 15: Move git-specific accessors from contracts/signal-utils.ts to trajectory/git/

**Files:**

- Modify: `src/core/contracts/signal-utils.ts` — keep only `normalize()`,
  `p95()`
- Move: `resolveFile`, `resolveChunk`, `fileSignal`, `fileNum`, `chunkNum`,
  `hasChunkData`, etc. → `src/core/trajectory/git/infra/signal-utils.ts`

These are git-domain-specific payload accessors. They don't belong in
contracts/.

Run: `npx tsc --noEmit && npx vitest run` Expected: ALL PASS

**Commit:**

```bash
git add -A
git commit -m "refactor: move git payload accessors from contracts/ to trajectory/git/infra/"
```

### Task 16: Final test suite verification

Run: `npx tsc --noEmit && npx vitest run` Expected: ALL PASS

---

## Phase 9: Knowledge Base Article — Normalization Methods

### Task 17: Write normalization methods article

**Files:**

- Create: `website/docs/knowledge-base/normalization-methods.md`

Article covering:

1. **Linear normalization** (`value/max`, clamped 0-1) — our primary method,
   used for most signals
2. **Adaptive bounds** (p95 from result batch + floor) — why and how we compute
   per-query bounds
3. **Confidence dampening** (quadratic `(n/k)^2` per-signal) — statistical
   reliability for small samples
4. **Alpha-blending** (L3: `alpha * chunk + (1-alpha) * file`) —
   confidence-weighted file/chunk merging
5. **Laplace smoothing** (Jeffreys prior, alpha=0.5) — bugFixRate stabilization
6. **Size dampening** (`1 - exp(-size/S)`) — relativeChurn correction for small
   chunks
7. **Categorical mapping** (contributorCount → knowledgeSilo: 1/0.5/0) —
   non-numeric transforms
8. Comparison table: linear vs log vs sigmoid vs Bayesian shrinkage (from
   research docs)
9. Which methods we use where and why

Reference: `docs/researches/chunk-metric-corrections.md` (Section 3),
`docs/researches/chunk-file-interaction-model.md` (Section 4).

**Commit:**

```bash
git add website/docs/knowledge-base/normalization-methods.md
git commit -m "docs: normalization methods knowledge base article"
```

---

## Summary

| Phase | Tasks | Description                                                  |
| ----- | ----- | ------------------------------------------------------------ |
| 0     | 1     | Revert wrong Plan B, clean slate                             |
| 1     | 2-3   | DerivedSignalDescriptor in contracts, sources on git signals |
| 2     | 4-5   | Structural signal descriptors (similarity, chunkSize, etc.)  |
| 3     | 6     | Provider exposes derivedSignals                              |
| 4     | 7-9   | Reranker v2 with ranking overlay                             |
| 5     | 10    | Kill NormalizationBounds monolith                            |
| 6     | 11-12 | Wire into consumers + registry integration                   |
| 7     | 13    | Auto-generate ScoringWeightsSchema                           |
| 8     | 14-16 | Cleanup: close old tasks, move git accessors                 |
| 9     | 17    | Knowledge base article on normalization methods              |

**Total commits:** ~12 **Key new files:** `structural-signals.ts`,
`website/docs/knowledge-base/normalization-methods.md` **Key modified files:**
`reranker.ts` (monolith → Reranker v2), `signals.ts` (add sources),
`provider.ts` (add derivedSignals), `schemas.ts` (auto-generate) **Preserved:**
All scoring improvements (L3 alpha, quadratic confidence, adaptive bounds,
Laplace smoothing, continuous blockPenalty)
