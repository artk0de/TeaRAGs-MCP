# Reranker Decomposition Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to
> implement this plan task-by-task.

**Goal:** Decompose monolithic `reranker.ts` (618 lines) into GitReranker,
GenericReranker, and CompositeReranker with clean separation of concerns.

**Architecture:** Provider defines signals (raw fields). Reranker normalizes,
alpha-blends, confidence-dampens. CompositeReranker orchestrates trajectory
rerankers + structural signals. All normalization is private to reranker — no
separate normalization layer.

**Tech Stack:** TypeScript, Vitest

**Prerequisites:** Plan A (Domain Boundaries) must be complete. contracts/ layer
must exist.

---

## Phase 1: GitReranker — trajectory-level reranking

### Task 1: Write GitReranker tests

**Files:**

- Create: `tests/core/search/git-reranker.test.ts`

**Step 1: Write failing tests**

```typescript
import { describe, expect, it } from "vitest";

import type {
  NormalizationBounds,
  RerankableResult,
} from "../../../src/core/contracts/index.js";
import { GitReranker } from "../../../src/core/search/git-reranker.js";

const DEFAULT_BOUNDS: NormalizationBounds = {
  maxAgeDays: 365,
  maxCommitCount: 50,
  maxChunkSize: 500,
  maxImports: 20,
  maxBugFixRate: 100,
  maxVolatility: 60,
  maxChangeDensity: 20,
  maxChunkCommitCount: 30,
  maxRelativeChurn: 5.0,
  maxBurstActivity: 10.0,
  maxChunkChurnRatio: 1.0,
};

function makeResult(git?: Record<string, unknown>): RerankableResult {
  return {
    score: 0.8,
    payload: { relativePath: "src/a.ts", startLine: 1, endLine: 50, git },
  };
}

describe("GitReranker", () => {
  const reranker = new GitReranker();

  describe("extractSignals", () => {
    it("returns empty map for result without git data", () => {
      const signals = reranker.extractSignals(makeResult(), DEFAULT_BOUNDS);
      // All git signals should be 0
      expect(signals.recency).toBe(0);
      expect(signals.churn).toBe(0);
    });

    it("normalizes file-level ageDays to recency signal", () => {
      const result = makeResult({ file: { ageDays: 182 } });
      const signals = reranker.extractSignals(result, DEFAULT_BOUNDS);
      // recency = 1 - normalize(182, 365) ≈ 0.501
      expect(signals.recency).toBeCloseTo(1 - 182 / 365, 2);
    });

    it("applies alpha-blending when chunk data exists", () => {
      const result = makeResult({
        file: { commitCount: 10, ageDays: 100 },
        chunk: { commitCount: 5, ageDays: 30 },
      });
      const signals = reranker.extractSignals(result, DEFAULT_BOUNDS);
      // alpha = coverageRatio * maturity = (5/10) * min(1, 5/3) = 0.5 * 1 = 0.5
      // effectiveAgeDays = 0.5 * 30 + 0.5 * 100 = 65
      // recency = 1 - 65/365 ≈ 0.822
      expect(signals.recency).toBeCloseTo(1 - 65 / 365, 2);
    });

    it("applies confidence dampening to statistical signals", () => {
      const result = makeResult({ file: { commitCount: 2, bugFixRate: 50 } });
      const signals = reranker.extractSignals(result, DEFAULT_BOUNDS);
      // bugFix confidence threshold = 8
      // confidence = (2/8)^2 = 0.0625
      // raw = normalize(50, 100) = 0.5
      // dampened = 0.5 * 0.0625 = 0.03125
      expect(signals.bugFix).toBeCloseTo(0.5 * Math.pow(2 / 8, 2), 4);
    });

    it("computes ownership from dominantAuthorPct", () => {
      const result = makeResult({
        file: { commitCount: 10, dominantAuthorPct: 80 },
      });
      const signals = reranker.extractSignals(result, DEFAULT_BOUNDS);
      // ownership = 0.8 * confidence(10, "ownership") = 0.8 * 1.0 = 0.8
      expect(signals.ownership).toBeCloseTo(0.8, 2);
    });

    it("computes knowledgeSilo categorically", () => {
      const result1 = makeResult({
        file: { commitCount: 10, contributorCount: 1 },
      });
      const result2 = makeResult({
        file: { commitCount: 10, contributorCount: 2 },
      });
      const result3 = makeResult({
        file: { commitCount: 10, contributorCount: 5 },
      });
      expect(
        reranker.extractSignals(result1, DEFAULT_BOUNDS).knowledgeSilo,
      ).toBeCloseTo(1.0, 2);
      expect(
        reranker.extractSignals(result2, DEFAULT_BOUNDS).knowledgeSilo,
      ).toBeCloseTo(0.5, 2);
      expect(
        reranker.extractSignals(result3, DEFAULT_BOUNDS).knowledgeSilo,
      ).toBeCloseTo(0, 2);
    });

    it("applies blockPenalty as dataQualityDiscount", () => {
      const result = makeResult({ file: { commitCount: 10 } });
      result.payload!.chunkType = "block";
      const signals = reranker.extractSignals(result, DEFAULT_BOUNDS);
      // No chunk data → alpha = 0 → blockPenalty = 1.0 - 0 = 1.0
      expect(signals.blockPenalty).toBeCloseTo(1.0, 2);
    });
  });

  describe("presets", () => {
    it("has techDebt preset", () => {
      expect(reranker.presets.techDebt).toBeDefined();
      expect(reranker.presets.techDebt.similarity).toBeDefined();
    });

    it("has all semantic_search presets", () => {
      const expected = [
        "techDebt",
        "hotspots",
        "codeReview",
        "securityAudit",
        "refactoring",
        "ownership",
      ];
      for (const name of expected) {
        expect(reranker.presets[name]).toBeDefined();
      }
    });
  });
});
```

**Step 2: Run to verify failure**

Run: `npx vitest run tests/core/search/git-reranker.test.ts` Expected: FAIL —
GitReranker not found

---

### Task 2: Implement GitReranker

**Files:**

- Create: `src/core/search/git-reranker.ts`

**Step 1: Implement**

Extract git-specific signal logic from `reranker.ts` lines 337-516. All
normalization, alpha-blending, confidence dampening are private methods.

```typescript
/**
 * GitReranker — trajectory-level reranking for git signals.
 *
 * Responsibilities:
 * - Read raw signal values from git payload (file + chunk levels)
 * - Alpha-blend chunk/file signals based on data coverage
 * - Apply confidence dampening for statistical signals
 * - Normalize to 0-1 range
 * - Own git-specific presets (techDebt, hotspots, etc.)
 */

import { normalize } from "../contracts/signal-utils.js";
import type { ScoringWeights } from "../contracts/types/provider.js";
import type {
  NormalizationBounds,
  RerankableResult,
} from "../contracts/types/reranker.js";

// ... (full implementation extracted from reranker.ts calculateSignals)
```

Key methods:

- `extractSignals(result: RerankableResult, bounds: NormalizationBounds): Record<string, number>`
- Private: `computeAlpha()`, `effectiveSignal()`, `signalConfidence()`,
  `getOwnershipScore()`, `getKnowledgeSiloScore()`, `getDataQualityDiscount()`
- `readonly presets: Record<string, ScoringWeights>` — techDebt, hotspots,
  codeReview, securityAudit, refactoring, ownership

**Step 2: Run tests**

Run: `npx vitest run tests/core/search/git-reranker.test.ts` Expected: PASS

**Step 3: Commit**

```bash
git add src/core/search/git-reranker.ts tests/core/search/git-reranker.test.ts
git commit -m "feat(search): add GitReranker with alpha-blending and confidence dampening"
```

---

## Phase 2: GenericReranker — structural signals

### Task 3: Write GenericReranker tests

**Files:**

- Create: `tests/core/search/generic-reranker.test.ts`

Tests for 5 structural signals: similarity, chunkSize, documentation, imports,
pathRisk.

**Step 1: Write failing tests**

```typescript
import { describe, expect, it } from "vitest";

import { GenericReranker } from "../../../src/core/search/generic-reranker.js";

describe("GenericReranker", () => {
  const reranker = new GenericReranker();

  it("extracts similarity from result score", () => {
    const signals = reranker.extractSignals(
      { score: 0.85, payload: {} },
      bounds,
    );
    expect(signals.similarity).toBe(0.85);
  });

  it("normalizes chunkSize from line range", () => {
    const signals = reranker.extractSignals(
      { score: 0.5, payload: { startLine: 10, endLine: 110 } },
      bounds,
    );
    // chunkSize = normalize(100, 500) = 0.2
    expect(signals.chunkSize).toBeCloseTo(0.2, 2);
  });

  it("returns 1 for documentation", () => {
    const signals = reranker.extractSignals(
      { score: 0.5, payload: { isDocumentation: true } },
      bounds,
    );
    expect(signals.documentation).toBe(1);
  });

  it("normalizes imports count", () => {
    const signals = reranker.extractSignals(
      { score: 0.5, payload: { imports: ["a", "b", "c", "d", "e"] } },
      bounds,
    );
    // imports = normalize(5, 20) = 0.25
    expect(signals.imports).toBeCloseTo(0.25, 2);
  });

  it("detects pathRisk from security patterns", () => {
    const signals = reranker.extractSignals(
      { score: 0.5, payload: { relativePath: "src/auth/login.ts" } },
      bounds,
    );
    expect(signals.pathRisk).toBe(1);
  });
});
```

**Step 2: Run to verify failure**

Run: `npx vitest run tests/core/search/generic-reranker.test.ts` Expected: FAIL

---

### Task 4: Implement GenericReranker

**Files:**

- Create: `src/core/search/generic-reranker.ts`

Extract structural signal logic from `reranker.ts`. Simple and thin.

**Step 1: Implement**

**Step 2: Run tests**

Run: `npx vitest run tests/core/search/generic-reranker.test.ts` Expected: PASS

**Step 3: Commit**

```bash
git add src/core/search/generic-reranker.ts tests/core/search/generic-reranker.test.ts
git commit -m "feat(search): add GenericReranker for structural signals"
```

---

## Phase 3: CompositeReranker — orchestrator

### Task 5: Write CompositeReranker tests

**Files:**

- Create: `tests/core/search/composite-reranker.test.ts`

**Step 1: Write failing tests**

Tests for:

- Combines signals from GitReranker + GenericReranker
- Computes adaptive bounds (p95)
- Applies preset weights (calculateScore)
- Supports custom weights
- search_code presets (relevance, recent, stable)
- Handles results without git data gracefully

---

### Task 6: Implement CompositeReranker

**Files:**

- Create: `src/core/search/composite-reranker.ts`

Key logic:

- `constructor(rerankers: TrajectoryReranker[])` — stores trajectory rerankers
- `rerank(results, mode, presetSet)` → scored results
- Private: `computeAdaptiveBounds()`, `calculateScore()`
- GenericReranker built-in (structural signals always present)
- Composite presets include both structural + trajectory signal weights

**Step 1: Implement**

**Step 2: Run tests**

Run: `npx vitest run tests/core/search/composite-reranker.test.ts` Expected:
PASS

**Step 3: Commit**

```bash
git add src/core/search/composite-reranker.ts tests/core/search/composite-reranker.test.ts
git commit -m "feat(search): add CompositeReranker orchestrating trajectory + structural signals"
```

---

## Phase 4: Wire in and deprecate old reranker

### Task 7: Wire CompositeReranker into search-module

**Files:**

- Modify: `src/core/search/search-module.ts` — use CompositeReranker instead of
  reranker.ts functions
- Modify: `src/core/api/search-facade.ts` — construct CompositeReranker with
  providers

**Step 1: Update search-module to use CompositeReranker**

Replace calls to `rerankSemanticSearchResults()` and `rerankSearchCodeResults()`
with `compositeReranker.rerank()`.

**Step 2: Run integration tests**

Run: `npx vitest run` Expected: PASS

**Step 3: Commit**

```bash
git add -A
git commit -m "feat(search): wire CompositeReranker into search pipeline"
```

---

### Task 8: Deprecate old reranker.ts

**Files:**

- Modify: `src/core/search/reranker.ts` — add deprecation notices, thin facade
  that delegates to new rerankers

**Step 1: Convert reranker.ts to thin facade**

Keep exported function signatures for backward compat, but delegate internally
to CompositeReranker.

**Step 2: Run all tests**

Run: `npx tsc --noEmit && npx vitest run` Expected: ALL PASS

**Step 3: Commit**

```bash
git add -A
git commit -m "refactor: deprecate monolithic reranker.ts, delegate to CompositeReranker"
```

---

## Summary

| Phase | Tasks | Description                                                          |
| ----- | ----- | -------------------------------------------------------------------- |
| 1     | 1-2   | GitReranker: alpha-blending, confidence, git presets                 |
| 2     | 3-4   | GenericReranker: structural signals (similarity, chunkSize, etc.)    |
| 3     | 5-6   | CompositeReranker: orchestration, adaptive bounds, composite presets |
| 4     | 7-8   | Wire into search pipeline, deprecate old reranker.ts                 |

**Total commits:** ~8 **Estimated scope:** ~4 new files, ~3 modified files,
reranker.ts converted to facade

**Depends on:** Plan A (Domain Boundaries) — contracts/ layer must exist, Signal
terminology in place.
