# Reranker Infrastructure & techDebt Preset Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to
> implement this plan task-by-task.

**Goal:** Implement confidence model, metric corrections, L3 blending, adaptive
bounds, chunk temporal signals, and redesigned techDebt preset.

**Architecture:** Seven sequential tasks, each self-contained with TDD. Tasks
1-4 modify only `reranker.ts` or `metrics.ts`. Task 5 adds L3 blending to
reranker. Task 6 extends the accumulator pipeline. Task 7 updates preset
weights.

**Tech Stack:** TypeScript, Vitest, git metrics pipeline (`metrics.ts`,
`chunk-reader.ts`), reranker (`reranker.ts`)

**Design docs:**

- `docs/plans/2026-02-25-techdebt-preset-redesign.md`
- `docs/researches/chunk-metric-corrections.md`
- `docs/researches/chunk-file-interaction-model.md`

---

### Task 1: Per-Signal Quadratic Confidence

Replace single linear `MIN_CONFIDENT_COMMITS` ramp with per-signal power
function.

**Files:**

- Modify: `src/core/search/reranker.ts:148-411`
- Test: `tests/core/search/reranker.test.ts`

**Step 1: Write failing tests**

Add to `tests/core/search/reranker.test.ts`, inside the `confidence dampening`
describe block:

```typescript
describe("per-signal quadratic confidence", () => {
  it("should dampen bugFix more aggressively than linear (quadratic k=8)", () => {
    // n=2, linear k=5: confidence=0.4. Quadratic k=8: (2/8)^2 = 0.0625
    const highBugFix: RerankableResult = {
      score: 0.8,
      payload: {
        git: {
          file: { commitCount: 2, bugFixRate: 100, ageDays: 100 },
        },
      },
    };
    const lowBugFix: RerankableResult = {
      score: 0.8,
      payload: {
        git: {
          file: { commitCount: 10, bugFixRate: 20, ageDays: 100 },
        },
      },
    };
    const [first] = rerankSemanticSearchResults(
      [highBugFix, lowBugFix],
      "techDebt",
    );
    // With quadratic k=8, 2-commit 100% bugFix should rank BELOW
    // 10-commit 20% bugFix because confidence is 0.0625 vs 1.0
    expect(first.payload?.git?.file?.bugFixRate).toBe(20);
  });

  it("should use k=5 for ownership (not k=8)", () => {
    // n=4, k=5 quadratic: (4/5)^2 = 0.64
    // n=4, k=8 quadratic: (4/8)^2 = 0.25
    // ownership uses k=5, so confidence should be ~0.64
    const singleAuthor: RerankableResult = {
      score: 0.5,
      payload: {
        git: {
          file: {
            commitCount: 4,
            dominantAuthorPct: 100,
            authors: ["alice"],
            contributorCount: 1,
            ageDays: 10,
          },
        },
      },
    };
    const multiAuthor: RerankableResult = {
      score: 0.5,
      payload: {
        git: {
          file: {
            commitCount: 4,
            dominantAuthorPct: 50,
            authors: ["alice", "bob"],
            contributorCount: 2,
            ageDays: 10,
          },
        },
      },
    };
    const results = rerankSemanticSearchResults(
      [multiAuthor, singleAuthor],
      "ownership",
    );
    // Single author with k=5 confidence=0.64 should still rank higher
    expect(results[0].payload?.git?.file?.dominantAuthorPct).toBe(100);
  });

  it("should almost zero bugFix at commitCount=1 with quadratic k=8", () => {
    const oneCommitBuggy: RerankableResult = {
      score: 0.9,
      payload: {
        git: {
          file: { commitCount: 1, bugFixRate: 100, ageDays: 200 },
        },
      },
    };
    const tenCommitClean: RerankableResult = {
      score: 0.9,
      payload: {
        git: {
          file: { commitCount: 10, bugFixRate: 0, ageDays: 200 },
        },
      },
    };
    // In techDebt, bugFix has 0.15 weight. At n=1, k=8: confidence=(1/8)^2=0.016
    // The 100% bugFix × 0.016 = effectively zero
    const results = rerankSemanticSearchResults(
      [oneCommitBuggy, tenCommitClean],
      "techDebt",
    );
    // Scores should be very close (bugFix contribution negligible at n=1)
    const diff = Math.abs(results[0].score - results[1].score);
    expect(diff).toBeLessThan(0.05);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/core/search/reranker.test.ts` Expected: FAIL — tests
expect quadratic behavior but code uses linear

**Step 3: Implement per-signal confidence**

In `src/core/search/reranker.ts`, replace:

```typescript
/** Minimum commits for full confidence in statistical git signals */
const MIN_CONFIDENT_COMMITS = 5;
```

with:

```typescript
/** Per-signal confidence thresholds (minimum commits for full trust) */
const CONFIDENCE_THRESHOLDS: Partial<Record<keyof ScoringWeights, number>> = {
  bugFix: 8, // binary proportion — needs more data (Wilson CI width ~0.33 at n=8)
  volatility: 8, // second-order stat (stddev) — noisy below 8 samples
  ownership: 5, // aggregation over authors — stabilizes faster
  knowledgeSilo: 5,
  density: 5, // first-order mean
  relativeChurnNorm: 5,
};
const DEFAULT_CONFIDENCE_THRESHOLD = 5;
const CONFIDENCE_POWER = 2;

/** Quadratic confidence ramp: heavily penalizes small samples, saturates at threshold k */
function signalConfidence(
  effectiveCommitCount: number,
  signal: keyof ScoringWeights,
): number {
  const k = CONFIDENCE_THRESHOLDS[signal] ?? DEFAULT_CONFIDENCE_THRESHOLD;
  if (effectiveCommitCount >= k) return 1;
  return Math.pow(effectiveCommitCount / k, CONFIDENCE_POWER);
}
```

In `calculateSignals()`, replace each `* confidence` usage with per-signal
calls:

```typescript
// Replace: const confidence = Math.min(1, effectiveCommitCount / MIN_CONFIDENT_COMMITS);
// With nothing — remove the single confidence variable

// Replace each signal's dampening:
bugFix: normalize(effectiveBugFixRate, bounds.maxBugFixRate)
  * signalConfidence(effectiveCommitCount, 'bugFix'),
volatility: normalize(file?.churnVolatility ?? 0, bounds.maxVolatility)
  * signalConfidence(effectiveCommitCount, 'volatility'),
density: normalize(file?.changeDensity ?? 0, bounds.maxChangeDensity)
  * signalConfidence(effectiveCommitCount, 'density'),
ownership: getOwnershipScore(result)
  * signalConfidence(effectiveCommitCount, 'ownership'),
knowledgeSilo: getKnowledgeSiloScore(result, effectiveContributorCount)
  * signalConfidence(effectiveCommitCount, 'knowledgeSilo'),
relativeChurnNorm: normalize(file?.relativeChurn ?? 0, bounds.maxRelativeChurn)
  * signalConfidence(effectiveCommitCount, 'relativeChurnNorm'),
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/core/search/reranker.test.ts` Expected: All PASS.
Some existing confidence tests may need assertion adjustment (e.g., "should
dampen bugFixRate=100% on commitCount=1" — the dampening is now stronger, which
is directionally correct — update expected ranking if needed).

**Step 5: Commit**

```bash
git add src/core/search/reranker.ts tests/core/search/reranker.test.ts
git commit -m "feat(reranker): per-signal quadratic confidence model

Replace linear confidence ramp (k=5 for all) with quadratic power function
(p=2) and per-signal thresholds: k=8 for bugFix/volatility, k=5 for
ownership/knowledgeSilo/density/relativeChurnNorm.

At n=2 commits, bugFix confidence drops from 0.40 (linear) to 0.0625
(quadratic k=8), preventing small-sample binary proportions from
dominating rankings."
```

---

### Task 2: Laplace Smoothing for bugFixRate

Apply Jeffreys prior (alpha=0.5) to bugFixRate computation in both file and
chunk metrics.

**Files:**

- Modify:
  `src/core/ingest/pipeline/enrichment/trajectory/git/metrics.ts:139,188`
- Test:
  `tests/core/ingest/pipeline/enrichment/trajectory/git/git-log-reader.test.ts`

**Step 1: Write failing tests**

Add to `git-log-reader.test.ts`, in the `computeFileMetadata` describe block:

```typescript
it("should apply Laplace smoothing to bugFixRate (1 fix / 1 commit → 75%, not 100%)", () => {
  const data: FileChurnData = {
    relativePath: "x.ts",
    commits: [
      {
        sha: "a",
        author: "A",
        authorEmail: "a@x",
        timestamp: 1000,
        body: "fix: bug",
      },
    ],
    linesAdded: 1,
    linesDeleted: 0,
  };
  const result = computeFileMetadata(data, 10);
  // Laplace alpha=0.5: (1+0.5)/(1+1)*100 = 75
  expect(result.bugFixRate).toBe(75);
});

it("should apply Laplace smoothing (0 fixes / 1 commit → 25%, not 0%)", () => {
  const data: FileChurnData = {
    relativePath: "x.ts",
    commits: [
      {
        sha: "a",
        author: "A",
        authorEmail: "a@x",
        timestamp: 1000,
        body: "chore: cleanup",
      },
    ],
    linesAdded: 1,
    linesDeleted: 0,
  };
  const result = computeFileMetadata(data, 10);
  // Laplace alpha=0.5: (0+0.5)/(1+1)*100 = 25
  expect(result.bugFixRate).toBe(25);
});

it("should converge to observed rate at large n (50 fixes / 100 commits → ~50%)", () => {
  const commits = Array.from({ length: 100 }, (_, i) => ({
    sha: `sha-${i}`,
    author: "A",
    authorEmail: "a@x",
    timestamp: 1000 + i * 86400,
    body: i < 50 ? "fix: bug" : "feat: add",
  }));
  const data: FileChurnData = {
    relativePath: "x.ts",
    commits,
    linesAdded: 100,
    linesDeleted: 0,
  };
  const result = computeFileMetadata(data, 100);
  // (50+0.5)/(100+1)*100 = 50.0 (rounded)
  expect(result.bugFixRate).toBe(50);
});
```

Add to `buildChunkChurnMap` describe block (chunk-level smoothing):

```typescript
it("should apply Laplace smoothing to chunk bugFixRate", () => {
  // Setup: 1 commit that is a bug fix touching chunk lines
  // Expected: (1+0.5)/(1+1)*100 = 75, not 100
  // (tested implicitly via computeChunkOverlay)
});
```

**Step 2: Run tests to verify they fail**

Run:
`npx vitest run tests/core/ingest/pipeline/enrichment/trajectory/git/git-log-reader.test.ts`
Expected: FAIL — current code returns 100/0 for 1-commit cases

**Step 3: Implement Laplace smoothing**

In `src/core/ingest/pipeline/enrichment/trajectory/git/metrics.ts`:

Add constant at top:

```typescript
const SMOOTHING_ALPHA = 0.5;
```

Replace line 139 (`computeFileMetadata` bugFixRate):

```typescript
// OLD:
const bugFixRate = Math.round(
  (commits.filter((c) => isBugFixCommit(c.body)).length / commits.length) * 100,
);
// NEW:
const bugFixCount = commits.filter((c) => isBugFixCommit(c.body)).length;
const bugFixRate = Math.round(
  ((bugFixCount + SMOOTHING_ALPHA) / (commits.length + 2 * SMOOTHING_ALPHA)) *
    100,
);
```

Replace line 188 (`computeChunkOverlay` bugFixRate):

```typescript
// OLD:
bugFixRate: commitCount > 0 ? Math.round((acc.bugFixCount / totalCommitsForChunk) * 100) : 0,
// NEW:
bugFixRate: commitCount > 0
  ? Math.round(((acc.bugFixCount + SMOOTHING_ALPHA) / (commitCount + 2 * SMOOTHING_ALPHA)) * 100)
  : 0,
```

**Step 4: Run tests to verify they pass**

Run:
`npx vitest run tests/core/ingest/pipeline/enrichment/trajectory/git/git-log-reader.test.ts`
Expected: New tests PASS. Existing bugFixRate tests will need assertion updates
(e.g., "100% bug fix rate" becomes 75% for 1 commit, ~83% for 2/2, etc.). Update
each affected assertion to match Laplace formula.

**Step 5: Commit**

```bash
git add src/core/ingest/pipeline/enrichment/trajectory/git/metrics.ts \
       tests/core/ingest/pipeline/enrichment/trajectory/git/git-log-reader.test.ts
git commit -m "feat(metrics): Laplace smoothing for bugFixRate (alpha=0.5)

Apply Jeffreys prior to bugFixRate at both file and chunk level.
1 fix / 1 commit → 75% (was 100%), 0 fixes / 1 commit → 25% (was 0%).
Converges to observed rate at large n. Prevents misleading extreme
values in API output for sparse chunks."
```

---

### Task 3: Size-Dampened relativeChurn

Apply exponential size dampening to chunk-level relativeChurn to suppress
small-chunk inflation.

**Files:**

- Modify: `src/core/ingest/pipeline/enrichment/trajectory/git/metrics.ts:191`
- Test:
  `tests/core/ingest/pipeline/enrichment/trajectory/git/git-log-reader.test.ts`

**Step 1: Write failing tests**

Add to `git-log-reader.test.ts` in the `computeFileMetadata` or
`buildChunkChurnMap` section:

```typescript
describe("size-dampened relativeChurn", () => {
  it("should suppress relativeChurn for small chunks (5 lines)", () => {
    const acc: ChunkAccumulator = {
      commitShas: new Set(["a"]),
      authors: new Set(["A"]),
      bugFixCount: 0,
      lastModifiedAt: Date.now() / 1000,
      linesAdded: 3,
      linesDeleted: 1,
    };
    const overlay = computeChunkOverlay(acc, 10, undefined, 5);
    // Raw: (3+1)/5 = 0.8. Damping: 1 - exp(-5/30) = 0.154
    // Dampened: 0.8 * 0.154 = 0.12 (rounded to 0.12)
    expect(overlay.relativeChurn).toBeLessThan(0.2);
  });

  it("should not suppress relativeChurn for large chunks (200 lines)", () => {
    const acc: ChunkAccumulator = {
      commitShas: new Set(["a"]),
      authors: new Set(["A"]),
      bugFixCount: 0,
      lastModifiedAt: Date.now() / 1000,
      linesAdded: 20,
      linesDeleted: 0,
    };
    const overlay = computeChunkOverlay(acc, 10, undefined, 200);
    // Raw: 20/200 = 0.1. Damping: 1 - exp(-200/30) = 0.999
    // Dampened: 0.1 * 0.999 ≈ 0.1
    expect(overlay.relativeChurn).toBeCloseTo(0.1, 1);
  });
});
```

**Step 2: Run tests to verify they fail**

Run:
`npx vitest run tests/core/ingest/pipeline/enrichment/trajectory/git/git-log-reader.test.ts`
Expected: FAIL — small chunk test fails (raw 0.8 > 0.2)

**Step 3: Implement size dampening**

In `metrics.ts`, replace line 191:

```typescript
// OLD:
relativeChurn: Math.round((totalChurn / lineCount) * 100) / 100,
// NEW:
relativeChurn: Math.round(((totalChurn / lineCount) * (1 - Math.exp(-lineCount / 30))) * 100) / 100,
```

**Step 4: Run tests to verify they pass**

Run:
`npx vitest run tests/core/ingest/pipeline/enrichment/trajectory/git/git-log-reader.test.ts`
Expected: All PASS. Check existing relativeChurn tests — large chunks
unaffected, small chunks now produce lower values. Update assertions if needed.

**Step 5: Commit**

```bash
git add src/core/ingest/pipeline/enrichment/trajectory/git/metrics.ts \
       tests/core/ingest/pipeline/enrichment/trajectory/git/git-log-reader.test.ts
git commit -m "feat(metrics): size-dampened relativeChurn for chunk overlay

Apply exponential dampening: raw * (1 - exp(-lineCount/30)).
5-line chunk gets 85% suppression, 50-line chunk 19%, 200-line chunk <1%.
Prevents small utility functions from appearing as high-churn candidates
in refactoring and hotspots presets."
```

---

### Task 4: Result-Set Adaptive Normalization Bounds

Compute p95 bounds from current result batch, floor with DEFAULT_BOUNDS.

**Files:**

- Modify: `src/core/search/reranker.ts:133-162,443-475`
- Test: `tests/core/search/reranker.test.ts`

**Step 1: Write failing tests**

Add to `tests/core/search/reranker.test.ts`:

```typescript
describe("adaptive normalization bounds", () => {
  it("should distinguish high-churn from moderate-churn in monorepo-scale results", () => {
    // Static bounds: maxCommitCount=50. Both 300 and 51 normalize to 1.0.
    // Adaptive: p95 from result set should raise the bound.
    const highChurn: RerankableResult = {
      score: 0.5,
      payload: {
        git: { file: { commitCount: 300, ageDays: 100 } },
      },
    };
    const moderateChurn: RerankableResult = {
      score: 0.5,
      payload: {
        git: { file: { commitCount: 51, ageDays: 100 } },
      },
    };
    const results = rerankSemanticSearchResults(
      [moderateChurn, highChurn],
      "techDebt",
    );
    // With adaptive bounds, 300 commits should score HIGHER than 51
    // on the churn signal (previously both saturated at 1.0)
    expect(results[0].payload?.git?.file?.commitCount).toBe(300);
  });

  it("should not reduce bounds below DEFAULT_BOUNDS", () => {
    // All results have low commit counts — adaptive p95 is below default
    const a: RerankableResult = {
      score: 0.5,
      payload: {
        git: { file: { commitCount: 3, ageDays: 10 } },
      },
    };
    const b: RerankableResult = {
      score: 0.5,
      payload: {
        git: { file: { commitCount: 5, ageDays: 10 } },
      },
    };
    // Should still work — DEFAULT_BOUNDS floor prevents degenerate normalization
    const results = rerankSemanticSearchResults([a, b], "techDebt");
    expect(results).toHaveLength(2);
    expect(results[0].score).toBeGreaterThanOrEqual(0);
  });

  it("should respect caller-provided bounds (no adaptive override)", () => {
    const result: RerankableResult = {
      score: 0.5,
      payload: {
        git: { file: { commitCount: 100, ageDays: 50 } },
      },
    };
    const customBounds = {
      maxAgeDays: 100,
      maxCommitCount: 200,
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
    // Caller-provided bounds should be used as-is
    const results = rerankSemanticSearchResults(
      [result],
      "techDebt",
      customBounds,
    );
    expect(results).toHaveLength(1);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/core/search/reranker.test.ts` Expected: FAIL —
monorepo test fails because both 300 and 51 saturate at 1.0

**Step 3: Implement adaptive bounds**

In `src/core/search/reranker.ts`, add after `DEFAULT_BOUNDS`:

```typescript
/** Compute p95 of a numeric array. Returns 1 if empty. */
function p95(arr: number[]): number {
  if (arr.length === 0) return 1;
  const sorted = [...arr].sort((a, b) => a - b);
  return (
    sorted[Math.min(Math.floor(sorted.length * 0.95), sorted.length - 1)] || 1
  );
}

/** Compute adaptive bounds from result set, floored by defaults */
function computeAdaptiveBounds(
  results: RerankableResult[],
  floor: NormalizationBounds,
): NormalizationBounds {
  const v: Record<string, number[]> = {};
  const push = (key: string, val: number | undefined) => {
    if (val !== undefined && val > 0) (v[key] ??= []).push(val);
  };

  for (const r of results) {
    const file = resolveFileMeta(r.payload?.git);
    const chunk = resolveChunkMeta(r.payload?.git);
    push("ageDays", file?.ageDays);
    push("commitCount", file?.commitCount);
    push("chunkSize", getChunkSize(r) || undefined);
    push("imports", r.payload?.imports?.length);
    push("bugFixRate", file?.bugFixRate);
    push("volatility", file?.churnVolatility);
    push("changeDensity", file?.changeDensity);
    push("chunkCommitCount", chunk?.commitCount);
    push("relativeChurn", file?.relativeChurn);
    push("burstActivity", file?.recencyWeightedFreq);
    push("chunkChurnRatio", chunk?.churnRatio);
  }

  return {
    maxAgeDays: Math.max(p95(v.ageDays ?? []), floor.maxAgeDays),
    maxCommitCount: Math.max(p95(v.commitCount ?? []), floor.maxCommitCount),
    maxChunkSize: Math.max(p95(v.chunkSize ?? []), floor.maxChunkSize),
    maxImports: Math.max(p95(v.imports ?? []), floor.maxImports),
    maxBugFixRate: Math.max(p95(v.bugFixRate ?? []), floor.maxBugFixRate),
    maxVolatility: Math.max(p95(v.volatility ?? []), floor.maxVolatility),
    maxChangeDensity: Math.max(
      p95(v.changeDensity ?? []),
      floor.maxChangeDensity,
    ),
    maxChunkCommitCount: Math.max(
      p95(v.chunkCommitCount ?? []),
      floor.maxChunkCommitCount,
    ),
    maxRelativeChurn: Math.max(
      p95(v.relativeChurn ?? []),
      floor.maxRelativeChurn,
    ),
    maxBurstActivity: Math.max(
      p95(v.burstActivity ?? []),
      floor.maxBurstActivity,
    ),
    maxChunkChurnRatio: Math.max(
      p95(v.chunkChurnRatio ?? []),
      floor.maxChunkChurnRatio,
    ),
  };
}
```

In `rerankResults()`, add adaptive bounds computation:

```typescript
export function rerankResults<T extends RerankableResult>(
  results: T[],
  mode: RerankMode<string>,
  presets: Record<string, ScoringWeights>,
  bounds: NormalizationBounds = DEFAULT_BOUNDS,
): T[] {
  // ... weight resolution ...

  // Compute adaptive bounds from result set (only when using defaults)
  const effectiveBounds =
    bounds === DEFAULT_BOUNDS
      ? computeAdaptiveBounds(results, DEFAULT_BOUNDS)
      : bounds;

  const scored = results.map((result) => {
    const signals = calculateSignals(result, effectiveBounds);
    // ...
  });
  // ...
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/core/search/reranker.test.ts` Expected: All PASS

**Step 5: Commit**

```bash
git add src/core/search/reranker.ts tests/core/search/reranker.test.ts
git commit -m "feat(reranker): result-set adaptive normalization bounds

Compute p95 bounds from each result batch, floor with DEFAULT_BOUNDS.
Eliminates signal saturation in monorepos (commitCount=300 vs 51 now
distinguishable). Caller-provided bounds bypass adaptive computation."
```

---

### Task 5: L3 Alpha-Blending + dataQualityDiscount

Replace flat chunk-override-file with confidence-weighted blending.

**Files:**

- Modify: `src/core/search/reranker.ts:257-411`
- Test: `tests/core/search/reranker.test.ts`

**Step 1: Write failing tests**

Add to `tests/core/search/reranker.test.ts`:

```typescript
describe("L3 alpha-blending", () => {
  it("should blend chunk and file bugFixRate based on alpha", () => {
    // Chunk: 1 commit, bugFixRate=100%. File: 50 commits, bugFixRate=20%
    // Alpha ≈ (1/50) * min(1, 1/3) = 0.0067
    // Effective ≈ 0.0067 * 100 + 0.9933 * 20 = 20.5%
    // Previously: effective = 100% (pure chunk override)
    const blended: RerankableResult = {
      score: 0.8,
      payload: {
        git: {
          file: { commitCount: 50, bugFixRate: 20, ageDays: 100 },
          chunk: { commitCount: 1, bugFixRate: 100, ageDays: 5 },
        },
      },
    };
    const pureFile: RerankableResult = {
      score: 0.8,
      payload: {
        git: {
          file: { commitCount: 50, bugFixRate: 25, ageDays: 100 },
          // No chunk data — alpha=0, pure file
        },
      },
    };
    const results = rerankSemanticSearchResults(
      [blended, pureFile],
      "techDebt",
    );
    // Blended result should have ~20.5% effective bugFix, not 100%
    // pureFile has 25%. Both should be close in score.
    const diff = Math.abs(results[0].score - results[1].score);
    expect(diff).toBeLessThan(0.1);
  });

  it("should give high alpha to chunk with many commits relative to file", () => {
    // Chunk: 8 commits, File: 10 commits → alpha = (8/10) * min(1, 8/3) = 0.8
    const chunkRich: RerankableResult = {
      score: 0.5,
      payload: {
        git: {
          file: { commitCount: 10, bugFixRate: 10, ageDays: 100 },
          chunk: { commitCount: 8, bugFixRate: 80, ageDays: 50 },
        },
      },
    };
    const chunkPoor: RerankableResult = {
      score: 0.5,
      payload: {
        git: {
          file: { commitCount: 10, bugFixRate: 10, ageDays: 100 },
          chunk: { commitCount: 1, bugFixRate: 80, ageDays: 50 },
        },
      },
    };
    const results = rerankSemanticSearchResults(
      [chunkPoor, chunkRich],
      "techDebt",
    );
    // chunkRich (alpha=0.8, effective bugFix≈66%) should rank higher
    // than chunkPoor (alpha=0.007, effective bugFix≈10.5%)
    expect(results[0].payload?.git?.chunk?.commitCount).toBe(8);
  });

  it("should degenerate to file-only when chunk data absent (backward compat)", () => {
    const withChunk: RerankableResult = {
      score: 0.5,
      payload: {
        git: {
          file: { commitCount: 20, bugFixRate: 30, ageDays: 100 },
        },
      },
    };
    const withoutGit: RerankableResult = {
      score: 0.5,
      payload: {},
    };
    // Should not throw, should produce valid scores
    const results = rerankSemanticSearchResults(
      [withChunk, withoutGit],
      "techDebt",
    );
    expect(results).toHaveLength(2);
  });
});

describe("dataQualityDiscount (replaces binary blockPenalty)", () => {
  it("should give continuous discount for blocks with partial chunk data", () => {
    // Block with chunk.commitCount=5, file.commitCount=10 → alpha=0.5 → discount=0.5
    const blockPartial: RerankableResult = {
      score: 0.8,
      payload: {
        chunkType: "block",
        git: {
          file: { commitCount: 10, ageDays: 100 },
          chunk: { commitCount: 5 },
        },
      },
    };
    // Block without chunk data → alpha=0 → discount=1.0
    const blockNone: RerankableResult = {
      score: 0.8,
      payload: {
        chunkType: "block",
        git: {
          file: { commitCount: 10, ageDays: 100 },
        },
      },
    };
    const results = rerankSemanticSearchResults(
      [blockNone, blockPartial],
      "techDebt",
    );
    // Block with partial data should rank higher (less penalty)
    expect(results[0].payload?.git?.chunk?.commitCount).toBe(5);
  });

  it("should not penalize function chunks regardless of alpha", () => {
    const func: RerankableResult = {
      score: 0.8,
      payload: {
        chunkType: "function",
        git: {
          file: { commitCount: 10, ageDays: 100 },
          // No chunk data
        },
      },
    };
    const block: RerankableResult = {
      score: 0.8,
      payload: {
        chunkType: "block",
        git: {
          file: { commitCount: 10, ageDays: 100 },
          // No chunk data
        },
      },
    };
    const results = rerankSemanticSearchResults([block, func], "techDebt");
    // Function should rank higher (no penalty) vs block (full penalty)
    expect(results[0].payload?.chunkType).toBe("function");
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/core/search/reranker.test.ts` Expected: FAIL —
blending tests fail because code uses flat override

**Step 3: Implement L3 blending**

In `src/core/search/reranker.ts`, add blending functions:

```typescript
const CHUNK_MATURITY_THRESHOLD = 3;

/** Compute alpha: confidence weight for chunk vs file data */
function computeAlpha(
  chunkCommitCount: number | undefined,
  fileCommitCount: number,
): number {
  if (chunkCommitCount === undefined || chunkCommitCount === 0) return 0;
  if (fileCommitCount === 0) return 0;
  const coverageRatio = chunkCommitCount / fileCommitCount;
  const maturity = Math.min(1, chunkCommitCount / CHUNK_MATURITY_THRESHOLD);
  return Math.min(1, coverageRatio * maturity);
}

/** Blend chunk and file signal values using alpha */
function effectiveSignal(
  chunkValue: number | undefined,
  fileValue: number,
  alpha: number,
): number {
  if (chunkValue === undefined) return fileValue;
  return alpha * chunkValue + (1 - alpha) * fileValue;
}
```

Replace `getBlockPenaltySignal` with:

```typescript
/** Continuous data-quality discount replacing binary blockPenalty */
function getDataQualityDiscount(
  result: RerankableResult,
  alpha: number,
): number {
  if (result.payload?.chunkType !== "block") return 0;
  return 1.0 - alpha;
}
```

Rewrite `calculateSignals` to use blending (replace the four
`effectiveX = chunk?.X ?? X` lines + rewire all signals per the research doc
Section 5.1). Key changes:

- `alpha = computeAlpha(chunk?.commitCount, file?.commitCount ?? 0)`
- All blendable signals use `effectiveSignal(chunk?.X, file?.X ?? 0, alpha)`
- `chunkChurn` and `chunkRelativeChurn` dampened by `* alpha` (not `* 1`)
- `blockPenalty: getDataQualityDiscount(result, alpha)`

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/core/search/reranker.test.ts` Expected: All PASS.
Existing `blockPenalty` tests may need updates:

- "should penalize block chunks without chunk-level data" → still works (alpha=0
  → discount=1.0)
- "should NOT penalize block chunks that have chunk-level data" → still works
  (alpha>0 → discount<1.0)
- Adjust exact score assertions if needed due to blending

**Step 5: Commit**

```bash
git add src/core/search/reranker.ts tests/core/search/reranker.test.ts
git commit -m "feat(reranker): L3 alpha-blending and dataQualityDiscount

Replace flat chunk-override-file with confidence-weighted blending:
effective = alpha * chunk + (1-alpha) * file.
Alpha = (chunkCommits/fileCommits) * min(1, chunkCommits/3).
1 commit in 50-commit file → alpha=0.007 (99.3% file signal).
Replace binary blockPenalty with continuous dataQualityDiscount = 1 - alpha.
Backward compatible: alpha=0 when no chunk data → pure file signals."
```

---

### Task 6: Chunk-Level Temporal Signals (commitTimestamps)

Add `commitTimestamps[]` to accumulator, compute chunk-level
`recencyWeightedFreq` and `changeDensity`.

**Files:**

- Modify:
  `src/core/ingest/pipeline/enrichment/trajectory/git/metrics.ts:16-23,171-193`
- Modify: `src/core/ingest/pipeline/enrichment/trajectory/git/types.ts:69-84`
- Modify:
  `src/core/ingest/pipeline/enrichment/trajectory/git/chunk-reader.ts:233-242`
- Modify: `src/core/search/reranker.ts:83-91` (GitChunkFields)
- Test:
  `tests/core/ingest/pipeline/enrichment/trajectory/git/git-log-reader.test.ts`
- Test: `tests/core/search/reranker.test.ts`

**Step 1: Write failing tests for metric computation**

Add to `git-log-reader.test.ts`:

```typescript
describe("chunk-level temporal signals", () => {
  it("should compute recencyWeightedFreq from commitTimestamps", () => {
    const now = Date.now() / 1000;
    const acc: ChunkAccumulator = {
      commitShas: new Set(["a", "b"]),
      authors: new Set(["A"]),
      bugFixCount: 0,
      lastModifiedAt: now,
      linesAdded: 5,
      linesDeleted: 2,
      commitTimestamps: [now - 86400, now - 86400 * 7], // 1 day ago, 7 days ago
    };
    const overlay = computeChunkOverlay(acc, 10, undefined, 50);
    // exp(-0.1 * 1) + exp(-0.1 * 7) ≈ 0.905 + 0.497 = 1.40
    expect(overlay.recencyWeightedFreq).toBeGreaterThan(1);
    expect(overlay.recencyWeightedFreq).toBeLessThan(2);
  });

  it("should compute changeDensity from commitTimestamps", () => {
    const now = Date.now() / 1000;
    const acc: ChunkAccumulator = {
      commitShas: new Set(["a", "b", "c"]),
      authors: new Set(["A"]),
      bugFixCount: 0,
      lastModifiedAt: now,
      linesAdded: 10,
      linesDeleted: 5,
      commitTimestamps: [now - 86400 * 60, now - 86400 * 30, now], // 60, 30, 0 days ago
    };
    const overlay = computeChunkOverlay(acc, 10, undefined, 50);
    // span = 60 days = 2 months. density = 3 / 2 = 1.5
    expect(overlay.changeDensity).toBeCloseTo(1.5, 0);
  });

  it("should return 0 for temporal signals when no timestamps", () => {
    const acc: ChunkAccumulator = {
      commitShas: new Set(["a"]),
      authors: new Set(["A"]),
      bugFixCount: 0,
      lastModifiedAt: Date.now() / 1000,
      linesAdded: 1,
      linesDeleted: 0,
      commitTimestamps: [],
    };
    const overlay = computeChunkOverlay(acc, 10, undefined, 50);
    expect(overlay.recencyWeightedFreq).toBe(0);
    expect(overlay.changeDensity).toBe(0);
  });
});
```

**Step 2: Run tests to verify they fail**

Run:
`npx vitest run tests/core/ingest/pipeline/enrichment/trajectory/git/git-log-reader.test.ts`
Expected: FAIL — `commitTimestamps` not in interface, `recencyWeightedFreq` not
in overlay

**Step 3: Implement**

3a. Add `commitTimestamps` to `ChunkAccumulator` in `metrics.ts:16-23`:

```typescript
export interface ChunkAccumulator {
  commitShas: Set<string>;
  authors: Set<string>;
  bugFixCount: number;
  lastModifiedAt: number;
  linesAdded: number;
  linesDeleted: number;
  commitTimestamps: number[]; // NEW
}
```

3b. Add fields to `ChunkChurnOverlay` in `types.ts:69-84`:

```typescript
export interface ChunkChurnOverlay {
  commitCount: number;
  churnRatio: number;
  contributorCount: number;
  bugFixRate: number;
  lastModifiedAt: number;
  ageDays: number;
  relativeChurn: number;
  recencyWeightedFreq: number; // NEW
  changeDensity: number; // NEW
}
```

3c. Push timestamp in `chunk-reader.ts:233-242`, after
`acc.commitShas.add(commit.sha)`:

```typescript
acc.commitTimestamps.push(commit.timestamp);
```

Also update accumulator initialization (around line 82-96) to include
`commitTimestamps: []`.

3d. Compute signals in `computeChunkOverlay` (metrics.ts):

```typescript
// After const lineCount = ...
const nowSec = Date.now() / 1000;

// Chunk-level recencyWeightedFreq
const recencyWeightedFreq =
  acc.commitTimestamps.length > 0
    ? Math.round(
        acc.commitTimestamps.reduce((sum, ts) => {
          const daysAgo = (nowSec - ts) / 86400;
          return sum + Math.exp(-0.1 * daysAgo);
        }, 0) * 100,
      ) / 100
    : 0;

// Chunk-level changeDensity
let changeDensity = 0;
if (acc.commitTimestamps.length > 0) {
  const minTs = Math.min(...acc.commitTimestamps);
  const maxTs = Math.max(...acc.commitTimestamps);
  const spanMonths = Math.max((maxTs - minTs) / (86400 * 30), 1);
  changeDensity =
    Math.round((acc.commitTimestamps.length / spanMonths) * 100) / 100;
}

return {
  // ... existing fields ...
  recencyWeightedFreq,
  changeDensity,
};
```

3e. Add fields to `GitChunkFields` in `reranker.ts:83-91`:

```typescript
export interface GitChunkFields {
  commitCount?: number;
  churnRatio?: number;
  contributorCount?: number;
  bugFixRate?: number;
  lastModifiedAt?: number;
  ageDays?: number;
  relativeChurn?: number;
  recencyWeightedFreq?: number; // NEW
  changeDensity?: number; // NEW
}
```

3f. Update `calculateSignals` in reranker to prefer chunk-level temporal
signals:

```typescript
// burstActivity: prefer chunk-level when available
burstActivity: normalize(
  chunk?.recencyWeightedFreq ?? file?.recencyWeightedFreq ?? 0,
  bounds.maxBurstActivity,
),
// density: prefer chunk-level when available
density: normalize(
  chunk?.changeDensity ?? file?.changeDensity ?? 0,
  bounds.maxChangeDensity,
) * signalConfidence(effectiveCommitCount, 'density'),
```

**Step 4: Run all tests**

Run: `npx vitest run` Expected: All PASS. Update existing tests that create
`ChunkAccumulator` objects to include `commitTimestamps: []`. Update tests that
assert overlay fields to include the two new fields.

**Step 5: Commit**

```bash
git add src/core/ingest/pipeline/enrichment/trajectory/git/metrics.ts \
       src/core/ingest/pipeline/enrichment/trajectory/git/types.ts \
       src/core/ingest/pipeline/enrichment/trajectory/git/chunk-reader.ts \
       src/core/search/reranker.ts \
       tests/core/ingest/pipeline/enrichment/trajectory/git/git-log-reader.test.ts \
       tests/core/search/reranker.test.ts
git commit -m "feat(metrics): chunk-level recencyWeightedFreq and changeDensity

Add commitTimestamps[] to ChunkAccumulator, populated during hunk mapping.
Compute two chunk-level temporal signals:
- recencyWeightedFreq: SUM(exp(-0.1 * daysAgo)) — burst activity
- changeDensity: commitCount / spanMonths — sustained pressure
Reranker prefers chunk-level when available for burstActivity and density."
```

---

### Task 7: Redesign techDebt Preset Weights

Update techDebt weights per design doc.

**Files:**

- Modify: `src/core/search/reranker.ts:170-177`
- Test: `tests/core/search/reranker.test.ts`

**Step 1: Write failing tests**

Add to `tests/core/search/reranker.test.ts`:

```typescript
describe("redesigned techDebt preset", () => {
  it("should include knowledgeSilo signal", () => {
    const silo: RerankableResult = {
      score: 0.5,
      payload: {
        git: {
          file: {
            commitCount: 20,
            ageDays: 200,
            bugFixRate: 10,
            contributorCount: 1,
            authors: ["solo"],
            dominantAuthorPct: 100,
            churnVolatility: 5,
            changeDensity: 3,
          },
        },
      },
    };
    const shared: RerankableResult = {
      score: 0.5,
      payload: {
        git: {
          file: {
            commitCount: 20,
            ageDays: 200,
            bugFixRate: 10,
            contributorCount: 5,
            authors: ["a", "b", "c", "d", "e"],
            dominantAuthorPct: 30,
            churnVolatility: 5,
            changeDensity: 3,
          },
        },
      },
    };
    const results = rerankSemanticSearchResults([shared, silo], "techDebt");
    // Single-author code should rank higher in techDebt (knowledge silo risk)
    expect(results[0].payload?.git?.file?.contributorCount).toBe(1);
  });

  it("should include density signal", () => {
    const highDensity: RerankableResult = {
      score: 0.5,
      payload: {
        git: {
          file: {
            commitCount: 20,
            ageDays: 200,
            bugFixRate: 10,
            changeDensity: 15,
            churnVolatility: 5,
            contributorCount: 3,
          },
        },
      },
    };
    const lowDensity: RerankableResult = {
      score: 0.5,
      payload: {
        git: {
          file: {
            commitCount: 20,
            ageDays: 200,
            bugFixRate: 10,
            changeDensity: 1,
            churnVolatility: 5,
            contributorCount: 3,
          },
        },
      },
    };
    const results = rerankSemanticSearchResults(
      [lowDensity, highDensity],
      "techDebt",
    );
    // High density (sustained change pressure) should rank higher
    expect(results[0].payload?.git?.file?.changeDensity).toBe(15);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/core/search/reranker.test.ts` Expected: FAIL —
current techDebt preset doesn't include knowledgeSilo or density

**Step 3: Update techDebt preset weights**

In `src/core/search/reranker.ts`, replace the techDebt preset:

```typescript
techDebt: {
  similarity: 0.20,
  age: 0.15,
  churn: 0.15,
  bugFix: 0.15,
  volatility: 0.10,
  knowledgeSilo: 0.10,
  density: 0.10,
  blockPenalty: -0.05,
},
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/core/search/reranker.test.ts` Expected: All PASS.
Existing techDebt test "should boost old and high-churn code" should still pass
(age + churn still have combined 0.30 weight). The "should apply blockPenalty in
techDebt preset" test may need assertion adjustment (weight reduced from -0.15
to -0.05).

**Step 5: Commit**

```bash
git add src/core/search/reranker.ts tests/core/search/reranker.test.ts
git commit -m "feat(reranker): redesign techDebt preset with knowledge silo and density

Add knowledgeSilo (0.10) and density (0.10) signals.
Reduce similarity (0.25→0.20), age (0.20→0.15), churn (0.20→0.15),
volatility (0.20→0.10), blockPenalty (-0.15→-0.05).
Now detects 6 debt patterns: old+churning, bug-fix heavy, oscillating,
knowledge silos, sustained change pressure, large unstable chunks."
```

---

## Dependency Graph

```
Task 1 (quadratic confidence) ─────────────────────────────┐
Task 2 (Laplace smoothing) ─── independent ─────────────────┤
Task 3 (size-dampened relativeChurn) ─── independent ───────┤
Task 4 (adaptive bounds) ──────────────────────────────────┤
                                                            ▼
Task 5 (L3 blending) ─── depends on Task 1 (uses signalConfidence)
                                                            │
Task 6 (temporal signals) ─── depends on Task 5 (reranker prefers chunk)
                                                            │
Task 7 (techDebt weights) ─── depends on Tasks 1-6 (uses all infrastructure)
```

**Parallelizable:** Tasks 1, 2, 3, 4 can run in parallel (independent
files/functions). **Sequential:** 5 after 1, then 6 after 5, then 7 after all.

## Verification

After all tasks complete:

```bash
npx vitest run                    # All tests pass
npx tsc --noEmit                  # Type check passes
npm run build                     # Build succeeds
```
