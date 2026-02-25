# Chunk-Level and File-Level Git Metric Interaction Model

## Research Document for tea-rags Reranking Engine

**Date:** 2026-02-25
**Status:** Proposal
**Scope:** `src/core/search/reranker.ts` -- `calculateSignals()`, presets, blending logic

---

## 1. Executive Summary

The tea-rags reranker currently uses a flat "prefer chunk, fallback to file" strategy for
combining two granularity levels of git metrics. This approach has three structural problems:

1. **Unconditional chunk override.** A chunk with 1 commit overrides a file with 100 commits,
   even though the chunk signal has no statistical power.
2. **Binary blockPenalty.** Block chunks without chunk data receive a flat penalty rather than
   a principled confidence discount.
3. **No cross-level signal.** A stable chunk inside an unstable file (safe island) and an
   unstable chunk inside a stable file (localized hotspot) are indistinguishable from their
   same-level-only signals.

This document proposes an **L1/L2/L3 hierarchy** that replaces the current override logic with
confidence-weighted blending. The design:

- Introduces no new git operations (zero additional cost at index time or query time).
- Is backward compatible with existing presets and payload schemas.
- Handles missing data gracefully (old indexes without chunk-level data work unchanged).
- Provides a single `effectiveSignal()` function that replaces the current per-signal fallback.

The core formula is:

```text
effective(signal) = alpha * chunk(signal) + (1 - alpha) * file(signal)
```

where `alpha` is a confidence weight derived from the chunk's commit count relative to the
file's commit count.

---

## 2. Problem Analysis: Current Limitations

### 2.1. The Unconditional Override

Current code in `calculateSignals()`:

```typescript
const effectiveCommitCount = chunk?.commitCount ?? commitCount;
const effectiveAgeDays = chunk?.ageDays ?? ageDays;
const effectiveBugFixRate = chunk?.bugFixRate ?? file?.bugFixRate ?? 0;
```

This means: if chunk data exists (even with `commitCount = 1`), it completely replaces the
file-level value. The only dampening is a global confidence factor:

```typescript
const confidence = Math.min(1, effectiveCommitCount / MIN_CONFIDENT_COMMITS);
```

But `confidence` applies uniformly to statistical signals -- it does not modulate the
*blend ratio* between chunk and file. A chunk with `commitCount = 2, bugFixRate = 100%`
gets `confidence = 0.4` applied to its bug fix signal, but zero contribution from the
file's `bugFixRate = 20%` (based on 50 commits).

**Concrete failure case:**

| Level | commitCount | bugFixRate |
|-------|------------|------------|
| File | 50 | 20% |
| Chunk | 1 | 100% |

Current behavior: `effectiveBugFixRate = 100%`, dampened by `confidence = 0.2` to produce
signal `= 0.2`. File's reliable `20%` is discarded entirely.

A blended approach: `alpha = min(1, 1/50) * maturity_boost = ~0.02`, so
`effective = 0.02 * 100% + 0.98 * 20% = 21.6%`, dampened by
`confidence = min(1, 50/5) = 1.0` to produce signal `= 0.216`. More calibrated.

### 2.2. The Block Penalty as a Blunt Instrument

The `blockPenalty` signal is a binary flag:

```typescript
function getBlockPenaltySignal(result: RerankableResult): number {
  if (chunkType !== "block") return 0;
  if (chunk?.commitCount !== undefined) return 0;
  return 1.0;
}
```

This conflates two distinct situations:

1. **Block chunk, no chunk data, file has high churn** -- the block is inheriting file-level
   churn that may not belong to it. Penalty is reasonable.
2. **Block chunk, no chunk data, file has low churn** -- the block and file are both stable.
   Penalty is actively harmful (pushes stable block below unstable function chunks).

The penalty also has no gradation. A block in a 2-commit file and a block in a 200-commit
file receive the same penalty weight, despite radically different data-reliability profiles.

### 2.3. Missing Cross-Level Semantics

Four important quadrants exist when combining chunk and file instability:

| Chunk Stability | File Stability | Interpretation | Current Handling |
|----------------|----------------|----------------|------------------|
| Stable | Stable | Safe code | Correct (low signals) |
| Unstable | Unstable | True danger zone | Partially correct (chunk dominates) |
| **Stable** | **Unstable** | Safe island in churny file | Broken: chunk override hides file context |
| **Unstable** | **Stable** | Localized hotspot | Broken: file context lost after override |

The "safe island" case matters for the `hotspots` preset: a helper function inside a
frequently-modified file may have zero chunk commits, but the file-level churn causes it to
rank high. Conversely, a single churny function in an otherwise stable utility file should
signal a localized problem, but without cross-level blending, the file's stability dilutes
the finding (when file signals are used) or the chunk's instability is unanchored (when
chunk signals are used).

### 2.4. Signal Partitioning Problem

Currently, some signals are chunk-only and some are file-only:

| Signal | Source | Problem |
|--------|--------|---------|
| `chunkChurn` | chunk.commitCount | Zero when no chunk data (not file fallback) |
| `chunkRelativeChurn` | chunk.churnRatio | Zero when no chunk data |
| `burstActivity` | file.recencyWeightedFreq | Always file-level, never chunk-adjusted |
| `volatility` | file.churnVolatility | Always file-level, never chunk-adjusted |
| `density` | file.changeDensity | Always file-level, never chunk-adjusted |

This creates an implicit assumption in presets: `hotspots` uses both `chunkChurn` and
`burstActivity`, but the two signals have completely different data sources and coverage.
When chunk data is missing, `chunkChurn = 0` (penalizing the result) while `burstActivity`
may be high (boosting it). The net effect is unpredictable.

---

## 3. Proposed L1/L2/L3 Hierarchy

### 3.1. Layer Definitions

#### L1 -- File Context (always available)

Aggregate statistics from `git log` over the full file. High statistical confidence due to
large sample size (all commits touching any line in the file). Available for every chunk
that has git enrichment data.

Signals: `commitCount`, `ageDays`, `relativeChurn`, `recencyWeightedFreq`, `changeDensity`,
`churnVolatility`, `bugFixRate`, `contributorCount`, `dominantAuthorPct`.

#### L2 -- Chunk Specifics (conditionally available)

Per-chunk overlay computed by mapping diff hunks to chunk line ranges. Available only for
chunks in files with >1 chunk, where hunk mapping succeeded. Lower statistical confidence
for chunks with few overlapping commits.

Signals: `commitCount`, `churnRatio`, `bugFixRate`, `contributorCount`, `ageDays`,
`relativeChurn`.

#### L3 -- Blended Score (computed at rerank time)

A confidence-weighted composite of L1 and L2 that replaces the current per-signal fallback.
Computed for each signal that has both file and chunk analogs.

### 3.2. Signal Classification

Each reranker signal falls into one of four categories based on how L1 and L2 interact:

| Category | Signals | Blending Strategy |
|----------|---------|-------------------|
| Blendable | commitCount, ageDays, bugFixRate, contributorCount, relativeChurn | `alpha * L2 + (1-alpha) * L1` |
| Chunk-native | churnRatio | Direct with chunk confidence |
| File-native | recencyWeightedFreq, changeDensity, churnVolatility, dominantAuthorPct | Direct from L1 |
| Non-git | similarity, chunkSize, documentation, imports, pathRisk | Independent of L1/L2 |

### 3.3. Why Three Layers, Not Two

A two-layer model (chunk or file) forces a binary choice. The three-layer model
provides a continuous spectrum:

- When `alpha = 0`: L3 degenerates to L1 (pure file). This is the correct behavior
  for chunks with no chunk data, or when chunk data has zero statistical power.
- When `alpha = 1`: L3 degenerates to L2 (pure chunk). This is the correct behavior
  for chunks with rich history and high commit counts.
- When `0 < alpha < 1`: L3 blends both levels. This is the correct behavior for
  chunks with partial data (few commits, but some signal).

---

## 4. Blending Strategies

### 4.1. Alpha Computation

The blending weight `alpha` represents our confidence in the chunk-level signal relative
to the file-level signal. It must satisfy:

1. `alpha = 0` when chunk data is absent.
2. `alpha` approaches 1 as chunk commit count approaches file commit count.
3. `alpha` rises quickly from 0 -- even a few chunk-specific commits carry information.
4. `alpha` never exceeds 1.

**Proposed formula (logistic curve):**

```text
alpha = min(1, (chunk.commitCount / file.commitCount) * maturityFactor)

maturityFactor = min(1, chunk.commitCount / CHUNK_MATURITY_THRESHOLD)

CHUNK_MATURITY_THRESHOLD = 3
```

This gives us:

```typescript
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
```

**Behavior at key points:**

| chunk.commitCount | file.commitCount | coverageRatio | maturity | alpha |
|-------------------|-----------------|---------------|----------|-------|
| 0 (or undefined) | any | -- | -- | 0.00 |
| 1 | 100 | 0.01 | 0.33 | 0.003 |
| 1 | 5 | 0.20 | 0.33 | 0.067 |
| 3 | 10 | 0.30 | 1.00 | 0.30 |
| 5 | 10 | 0.50 | 1.00 | 0.50 |
| 8 | 10 | 0.80 | 1.00 | 0.80 |
| 10 | 10 | 1.00 | 1.00 | 1.00 |
| 15 | 10 | 1.50 | 1.00 | 1.00 |

The maturity factor ensures that a single commit (`maturity = 0.33`) contributes only 1/3
of its coverage-based weight, even if that single commit represents 100% of a 1-commit
file's history.

### 4.2. Why Not a Simple Threshold?

An alternative is a hard threshold: use chunk if `chunk.commitCount >= N`, else file.
This was rejected because:

1. **Discontinuity.** At `N = 3`, a chunk with 2 commits uses file data; at 3 commits it
   switches entirely. Small changes in data cause large ranking jumps.
2. **Loss of partial signal.** A chunk with 2 commits has real information (e.g., both
   commits were bug fixes). A hard threshold discards this.
3. **Context insensitivity.** 3 commits in a 5-commit file is 60% coverage. 3 commits in
   a 500-commit file is 0.6% coverage. A fixed threshold treats both the same.

### 4.3. Why Not Use Bayesian Smoothing?

A Bayesian approach would model each chunk's metric as a posterior distribution,
using the file-level metric as the prior:

```text
posterior = (n * chunk_mean + k * prior_mean) / (n + k)
```

where `n = chunk.commitCount`, `k = smoothing constant`.

This is mathematically elegant but was rejected for practical reasons:

1. **Implementation complexity.** Requires maintaining a smoothing constant `k` that is
   interpretable across different metrics (bug fix rate vs. commit count vs. age).
2. **Debugging difficulty.** Users cannot easily reason about why a result ranked where
   it did when the blending involves Bayesian posteriors.
3. **Equivalent behavior.** For the linear blending formula, setting
   `k = CHUNK_MATURITY_THRESHOLD * fileCommitCount / chunkCommitCount` recovers the
   Bayesian posterior. The alpha formula is a simpler parameterization of the same idea.

### 4.4. The Effective Signal Function

Replaces all per-signal fallback logic with a single blending function:

```typescript
function effectiveSignal(
  chunkValue: number | undefined,
  fileValue: number,
  alpha: number,
): number {
  if (chunkValue === undefined) return fileValue;
  return alpha * chunkValue + (1 - alpha) * fileValue;
}
```

Applied in `calculateSignals()`:

```typescript
const alpha = computeAlpha(chunk?.commitCount, file?.commitCount ?? 0);

const effectiveCommitCount = effectiveSignal(
  chunk?.commitCount, file?.commitCount ?? 0, alpha
);
const effectiveAgeDays = effectiveSignal(
  chunk?.ageDays, file?.ageDays ?? 0, alpha
);
const effectiveBugFixRate = effectiveSignal(
  chunk?.bugFixRate, file?.bugFixRate ?? 0, alpha
);
const effectiveContributorCount = effectiveSignal(
  chunk?.contributorCount, file?.contributorCount ?? 0, alpha
);
const effectiveRelativeChurn = effectiveSignal(
  chunk?.relativeChurn, file?.relativeChurn ?? 0, alpha
);
```

### 4.5. Confidence Dampening (Retained, Adjusted)

The existing confidence dampening addresses a different concern: statistical reliability
of *any* commit count (whether blended or not). It should continue to apply on top of
blending:

```typescript
const confidence = Math.min(1, effectiveCommitCount / MIN_CONFIDENT_COMMITS);
```

With blending, `effectiveCommitCount` is now a weighted average, so confidence naturally
reflects the combined data. For a chunk with 1 commit in a 50-commit file:

```text
alpha = 0.003
effectiveCommitCount = 0.003 * 1 + 0.997 * 50 = 49.85
confidence = min(1, 49.85 / 5) = 1.0
```

The file's high commit count anchors the confidence. Compare to current behavior:

```text
effectiveCommitCount = 1  (chunk override)
confidence = min(1, 1 / 5) = 0.2
```

This is a significant improvement: the blended approach trusts the file's statistical base
while incorporating the chunk's directional signal.

---

## 5. Confidence-Weighted Blending: Full Formula

### 5.1. Complete calculateSignals with L3 Blending

```typescript
const CHUNK_MATURITY_THRESHOLD = 3;
const MIN_CONFIDENT_COMMITS = 5;

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

function effectiveSignal(
  chunkValue: number | undefined,
  fileValue: number,
  alpha: number,
): number {
  if (chunkValue === undefined) return fileValue;
  return alpha * chunkValue + (1 - alpha) * fileValue;
}

function calculateSignals(
  result: RerankableResult,
  bounds: NormalizationBounds,
): Record<string, number> {
  const git = result.payload?.git;
  const file = resolveFileMeta(git);
  const chunk = resolveChunkMeta(git);

  const fileCommitCount = file?.commitCount ?? 0;
  const fileAgeDays = file?.ageDays ?? 0;
  const chunkSize = getChunkSize(result);
  const imports = result.payload?.imports?.length ?? 0;

  // ── L3 blending ──────────────────────────────────────
  const alpha = computeAlpha(chunk?.commitCount, fileCommitCount);

  const effectiveCommitCount = effectiveSignal(
    chunk?.commitCount, fileCommitCount, alpha,
  );
  const effectiveAgeDays = effectiveSignal(
    chunk?.ageDays, fileAgeDays, alpha,
  );
  const effectiveBugFixRate = effectiveSignal(
    chunk?.bugFixRate, file?.bugFixRate ?? 0, alpha,
  );
  const effectiveContributorCount = effectiveSignal(
    chunk?.contributorCount, file?.contributorCount ?? 0, alpha,
  );
  const effectiveRelativeChurn = effectiveSignal(
    chunk?.relativeChurn, file?.relativeChurn ?? 0, alpha,
  );

  // Confidence based on blended commit count
  const confidence = Math.min(1, effectiveCommitCount / MIN_CONFIDENT_COMMITS);

  // ── Chunk-native signals (no file analog) ────────────
  // churnRatio is inherently relative to file; use directly with alpha as damper
  const chunkChurnValue = chunk?.commitCount ?? 0;
  const chunkChurnRatioValue = chunk?.churnRatio ?? 0;
  // When alpha is very low, chunk-native signals should be discounted
  const chunkConfidence = alpha;

  // ── File-native signals (no chunk analog) ────────────
  // These remain purely file-level.
  const burstActivityRaw = file?.recencyWeightedFreq ?? 0;
  const volatilityRaw = file?.churnVolatility ?? 0;
  const densityRaw = file?.changeDensity ?? 0;

  // ── Block penalty replacement ────────────────────────
  // Instead of a binary penalty, use (1 - alpha) as a data-quality discount.
  // High alpha = rich chunk data = no penalty.
  // Zero alpha (block without chunk data) = full penalty.
  const dataQualityDiscount = getDataQualityDiscount(result, alpha);

  return {
    similarity: result.score,

    // Blended signals (L3)
    recency: 1 - normalize(effectiveAgeDays, bounds.maxAgeDays),
    stability: 1 - normalize(effectiveCommitCount, bounds.maxCommitCount),
    churn: normalize(effectiveCommitCount, bounds.maxCommitCount),
    age: normalize(effectiveAgeDays, bounds.maxAgeDays),
    bugFix: normalize(effectiveBugFixRate, bounds.maxBugFixRate) * confidence,
    relativeChurnNorm:
      normalize(effectiveRelativeChurn, bounds.maxRelativeChurn) * confidence,

    // Ownership (file-level, dampened by blended confidence)
    ownership: getOwnershipScore(result) * confidence,
    knowledgeSilo:
      getKnowledgeSiloScore(result, effectiveContributorCount) * confidence,

    // Chunk-native signals (dampened by chunk confidence)
    chunkChurn:
      normalize(chunkChurnValue, bounds.maxChunkCommitCount) * chunkConfidence,
    chunkRelativeChurn:
      normalize(chunkChurnRatioValue, bounds.maxChunkChurnRatio) * chunkConfidence,

    // File-native signals (dampened by commit-count confidence)
    burstActivity: normalize(burstActivityRaw, bounds.maxBurstActivity),
    volatility: normalize(volatilityRaw, bounds.maxVolatility) * confidence,
    density: normalize(densityRaw, bounds.maxChangeDensity) * confidence,

    // Non-git signals (unchanged)
    chunkSize: normalize(chunkSize, bounds.maxChunkSize),
    documentation: result.payload?.isDocumentation ? 1 : 0,
    imports: normalize(imports, bounds.maxImports),
    pathRisk: getPathRiskScore(result),

    // Replaces binary blockPenalty
    blockPenalty: dataQualityDiscount,
  };
}
```

### 5.2. Data Quality Discount (Replaces blockPenalty)

The current `blockPenalty` is a binary 0/1 flag. The replacement is a continuous function:

```typescript
function getDataQualityDiscount(
  result: RerankableResult,
  alpha: number,
): number {
  const chunkType = result.payload?.chunkType;

  // Function/class/interface chunks: no discount even without chunk data.
  // Tree-sitter identified them as semantic units -- their boundaries are
  // meaningful even without hunk-mapping data.
  if (chunkType !== "block") return 0;

  // Block chunks: discount proportional to lack of chunk-specific data.
  // alpha = 0 (no chunk data) -> full discount (1.0)
  // alpha = 1 (rich chunk data) -> no discount (0.0)
  return 1.0 - alpha;
}
```

**Key behavioral difference from current blockPenalty:**

| Scenario | Current blockPenalty | New dataQualityDiscount |
|----------|---------------------|------------------------|
| Block, no chunk data, file has 2 commits | 1.0 | 1.0 |
| Block, no chunk data, file has 100 commits | 1.0 | 1.0 |
| Block, chunk.commitCount = 1, file = 100 | 0.0 | 0.997 |
| Block, chunk.commitCount = 5, file = 10 | 0.0 | 0.50 |
| Block, chunk.commitCount = 10, file = 10 | 0.0 | 0.0 |
| Function, no chunk data | 0.0 | 0.0 |
| Function, any chunk data | 0.0 | 0.0 |

The new model is strictly more granular. It preserves the existing behavior at the extremes
(no chunk data = full penalty for blocks, any named chunk = no penalty) while providing
continuous gradation for blocks with partial data.

---

## 6. Impact on Existing Presets

### 6.1. Preset Compatibility Analysis

The L3 blending changes which signals feed into presets, but **does not change preset
weight configurations**. All existing presets remain valid.

| Preset | Impact | Notes |
|--------|--------|-------|
| `techDebt` | Moderate | Blended churn/age/bugFix reduce noise |
| `hotspots` | High | Chunk signals dampened by alpha |
| `codeReview` | Moderate | chunkChurn dampened; recency blended |
| `refactoring` | High | Both chunk and blended signals affected |
| `onboarding` | Low | Stability uses blended commitCount |
| `securityAudit` | Low-moderate | age/bugFix/ownership blended |
| `ownership` | Low | knowledgeSilo uses blended contributorCount |
| `impactAnalysis` | None | No git signals used |
| `relevance` | None | Pure similarity |
| `recent` | Low | Recency now blended |
| `stable` | Low | Stability uses blended commitCount |

### 6.2. Hotspots Preset: Detailed Impact

The `hotspots` preset is most affected because it uses four chunk-aware signals:

```typescript
hotspots: {
  similarity: 0.25,
  chunkChurn: 0.15,         // now: dampened by alpha
  chunkRelativeChurn: 0.15, // now: dampened by alpha
  burstActivity: 0.15,      // unchanged (file-native)
  bugFix: 0.15,             // now: blended L3
  volatility: 0.15,         // unchanged (file-native, dampened by confidence)
  blockPenalty: -0.15,       // now: continuous via dataQualityDiscount
}
```

**Before (current):** A function chunk with `chunk.commitCount = 2` in a 50-commit file
gets full credit for `chunkChurn = normalize(2, 30) = 0.067` and `chunkRelativeChurn =
normalize(2/50, 1) = 0.04`. Its `bugFixRate` comes entirely from the chunk's 2 commits.

**After (proposed):** Same chunk gets `chunkChurn = 0.067 * alpha` where
`alpha = (2/50) * min(1, 2/3) = 0.027`. So `chunkChurn = 0.067 * 0.027 = 0.0018`.
This is a significant reduction. However, the blended `bugFix` now benefits from the
file's 50-commit statistical base.

**Net effect:** Chunks with very few commits will score lower on chunk-native signals but
higher on blended signals. The ranking change is directionally correct -- it prevents
low-data chunks from appearing as hotspots based on noise.

### 6.3. Should Preset Weights Be Adjusted?

No. The alpha dampening on chunk-native signals means those signals contribute less for
low-data chunks, but the normalization `score / totalWeight` in `calculateScore()` ensures
the total score remains in [0, 1]. The relative ordering within a result set is what matters,
and the blending improves relative ordering by suppressing noise.

If empirical evaluation (Section 9) shows that chunk-native signals are over-dampened
for the hotspots case, the fix is to increase `CHUNK_MATURITY_THRESHOLD` (making alpha
rise faster), not to change preset weights.

---

## 7. Edge Cases and Mitigations

### 7.1. Old Indexes Without Chunk Data

**Scenario:** Collection was indexed before chunk-level enrichment was added. All chunks
have `chunk = undefined`.

**Behavior:** `alpha = 0` for all chunks. All blendable signals degenerate to file-level
values. `chunkChurn` and `chunkRelativeChurn` are zero (same as current behavior).
`blockPenalty` = `1.0 - 0 = 1.0` for blocks, `0` for named chunks. **No behavioral change.**

### 7.2. Single-Chunk Files

**Scenario:** File has only one chunk (common for small files). Chunk-level analysis is
skipped entirely (`chunk-reader.ts` filters `entries.length <= 1`).

**Behavior:** `chunk = undefined`, `alpha = 0`. Pure file-level signals. Correct -- when
the chunk IS the file, chunk-level analysis adds no information.

### 7.3. Refactored Chunks (Stale Line Ranges)

**Scenario:** A chunk's line range shifted due to refactoring. The stored chunk overlay
maps to old line positions that no longer correspond to the current chunk content.

**Behavior:** The chunk overlay may show commits from code that is now in a different
chunk. This is a pre-existing data-quality issue (not introduced by blending). However,
blending mitigates it: when chunk data is stale, it will often show lower `commitCount`
(because recent commits map to new line ranges), resulting in lower `alpha` and more
weight on the file-level signal. This is a self-correcting property.

**Mitigation for future work:** Chunk overlay invalidation on re-index. When chunk line
ranges change, mark the old overlay as stale and recompute. Out of scope for this document.

### 7.4. Files With All Commits Touching All Chunks

**Scenario:** Every commit to the file modifies every chunk (e.g., formatting changes,
header updates, global refactors). `chunk.commitCount == file.commitCount` for all chunks.

**Behavior:** `alpha = min(1, 1.0 * min(1, N/3))`. For `N >= 3`, `alpha = 1.0`. Pure
chunk-level signals. Correct -- when the chunk has the same commit count as the file,
its data is just as reliable.

### 7.5. New File (0 Commits in Git Log)

**Scenario:** File was just created and has not been committed yet, or the git log time
window excludes all its commits.

**Behavior:** `file.commitCount = 0`, `alpha = 0` (division by zero guarded).
All signals default to zero. `confidence = 0`. Only `similarity`, `chunkSize`,
`documentation`, `imports`, and `pathRisk` contribute to the score. Correct.

### 7.6. Chunk CommitCount Exceeds File CommitCount

**Scenario:** Can happen when the chunk-level analysis window (`GIT_CHUNK_MAX_AGE_MONTHS`)
differs from the file-level window (`GIT_LOG_MAX_AGE_MONTHS`), or when the file-level
data was computed with a different safety depth.

**Behavior:** `coverageRatio > 1`, but `alpha = min(1, ...)` caps at 1.0. Pure chunk-level
signals. Correct -- the chunk data has higher resolution than the file data in this case.

### 7.7. Very Large Files With Many Chunks

**Scenario:** A 5000-line file with 100 chunks. File has 200 commits. Most chunks have
1-3 commits, a few hotspot chunks have 50+ commits.

**Behavior:** Alpha varies per chunk:

- Cold chunks (1-3 commits): `alpha ~ 0.002-0.015`. Nearly pure file-level signals.
  These will score similarly to each other.
- Hot chunks (50 commits): `alpha ~ 0.25`. Significant chunk influence.
  These will differentiate from the cold chunks.
- Very hot chunks (100+ commits): `alpha ~ 0.5-1.0`. Chunk-dominant.

This is the ideal behavior: within a large file, the blending naturally stratifies chunks
by data quality and produces a ranking that reflects actual hotspot distribution.

---

## 8. Decision Matrix

### 8.1. Signal-Level Decision Matrix

For each signal, the matrix specifies what data source to use and how:

| Signal Key | Chunk Field | File Field | Strategy | Confidence |
|-----------|-------------|------------|----------|------------|
| `recency` | `chunk.ageDays` | `file.ageDays` | L3 blend (alpha) | None (factual) |
| `stability` | `chunk.commitCount` | `file.commitCount` | L3 blend (alpha) | None (factual) |
| `churn` | `chunk.commitCount` | `file.commitCount` | L3 blend (alpha) | None (factual) |
| `age` | `chunk.ageDays` | `file.ageDays` | L3 blend (alpha) | None (factual) |
| `bugFix` | `chunk.bugFixRate` | `file.bugFixRate` | L3 blend (alpha) | * confidence |
| `ownership` | -- | `file.dominantAuthorPct` | File-only | * confidence |
| `knowledgeSilo` | `chunk.contributorCount` | `file.contributorCount` | L3 blend (alpha) | * confidence |
| `relativeChurnNorm` | `chunk.relativeChurn` | `file.relativeChurn` | L3 blend (alpha) | * confidence |
| `chunkChurn` | `chunk.commitCount` | -- | Chunk-only | * alpha |
| `chunkRelativeChurn` | `chunk.churnRatio` | -- | Chunk-only | * alpha |
| `burstActivity` | -- | `file.recencyWeightedFreq` | File-only | None (factual) |
| `volatility` | -- | `file.churnVolatility` | File-only | * confidence |
| `density` | -- | `file.changeDensity` | File-only | * confidence |
| `blockPenalty` | -- | -- | `1 - alpha` for blocks | N/A |

### 8.2. Chunk Type Decision Matrix

| Chunk Type | Has Chunk Data | Alpha | Block Penalty | Recommended Action |
|-----------|---------------|-------|---------------|-------------------|
| function | Yes, high | 0.5-1.0 | 0 | Trust chunk signals |
| function | Yes, low | 0.01-0.3 | 0 | Blend with file context |
| function | No | 0 | 0 | Use file signals |
| class | Yes/No | varies | 0 | Same as function |
| block | Yes, high | 0.5-1.0 | 0.0-0.5 | Trust chunk, low penalty |
| block | Yes, low | 0.01-0.3 | 0.7-0.99 | Blend, moderate penalty |
| block | No | 0 | 1.0 | File signals, full penalty |

---

## 9. Implementation Recommendations

### 9.1. Phase 1: Core Blending (Minimal Change)

**Files to modify:** `src/core/search/reranker.ts`

1. Add `computeAlpha()` function (5 lines).
2. Add `effectiveSignal()` function (3 lines).
3. Replace the four `effectiveX = chunk?.X ?? file?.X` lines in `calculateSignals()`
   with `effectiveSignal()` calls using computed alpha.
4. Apply `alpha` as confidence dampener on `chunkChurn` and `chunkRelativeChurn`.
5. Replace `getBlockPenaltySignal()` with `getDataQualityDiscount()`.

**Estimated diff:** ~40 lines changed, ~15 lines added, ~10 lines removed.

**Test strategy:** All existing tests must pass without modification. Add new tests for:

- Alpha computation at boundary values (0, 1, threshold).
- Blending behavior: chunk with 1 commit in 100-commit file.
- Block penalty gradation: block with partial chunk data.
- Regression: results without chunk data produce identical rankings.

### 9.2. Phase 2: Export Alpha for Debugging

Add `alpha` to the signals record returned by `calculateSignals()`:

```typescript
return {
  ...signals,
  _alpha: alpha,  // diagnostic, not used in scoring
};
```

This allows debugging reranking decisions without modifying the scoring path.

### 9.3. Phase 3: Evaluate and Tune

After deployment:

1. Compare rankings before/after on a representative query set.
2. Focus on `hotspots` and `refactoring` presets (most affected).
3. Tune `CHUNK_MATURITY_THRESHOLD` if chunk signals are over/under-dampened.
4. Consider making `CHUNK_MATURITY_THRESHOLD` a per-preset parameter if different
   presets need different sensitivity.

### 9.4. Constants

`CHUNK_MATURITY_THRESHOLD = 3`
: Minimum commits for a chunk to be considered "statistically present."
  3 commits provides enough data points to distinguish signal from noise
  (cf. Graves et al. 2000: "at least 3 changes needed for reliable
  fault prediction").

`MIN_CONFIDENT_COMMITS = 5`
: Existing constant, unchanged. Controls confidence dampening for
  statistical signals (bugFix, ownership, etc.). 5 commits aligns with
  Nagappan and Ball's finding that relative metrics stabilize after
  5+ data points.

### 9.5. Backward Compatibility

The change is backward compatible because:

1. **No payload schema changes.** The blending happens at query time in the reranker.
2. **No preset weight changes.** All preset configurations remain identical.
3. **No new signals.** The `blockPenalty` signal key is retained (its computation changes).
4. **Degenerate case = current behavior.** When `chunk = undefined`, `alpha = 0`, and all
   blended signals produce file-level values (same as current fallback).
5. **No API changes.** `rerankSemanticSearchResults()` and `rerankSearchCodeResults()`
   signatures are unchanged.

### 9.6. Instability Score (Future Extension)

Martin's Instability metric `I = Ce / (Ce + Ca)` operates at the package/module level.
For chunk-to-file interaction, an analogous "granularity instability" could be defined:

```text
chunkInstability = chunkChurnRatio * (1 - alpha)
```

Where high `chunkChurnRatio` (chunk is responsible for most file churn) combined with
low `alpha` (few commits, low confidence) produces high instability. This is not
proposed for Phase 1 but could be a useful signal for the `refactoring` preset.

The full blast radius instability metric (`Ce / (Ce + Ca)`) requires the `importedBy`
data from the code-graph enrichment provider (see `BLAST_RADIUS.md`, Phase B). When
that data is available, a combined instability signal could be:

```text
combinedInstability = w1 * martinInstability + w2 * chunkInstability
```

This would capture both architectural instability (dependency direction) and behavioral
instability (change pattern) in a single reranker signal.

---

## 10. References

1. Nagappan, N. & Ball, T. (2005). "Use of Relative Code Churn Measures to Predict
   System Defect Density." ICSE 2005, pp. 284-292.
   *Relative metrics >> absolute; 89% accuracy on Windows Server 2003.*

2. Graves, T.L., Karr, A.F., Marron, J.S., & Siy, H. (2000). "Predicting Fault
   Incidence Using Software Change History." IEEE TSE, 26(7), pp. 653-661.
   *Time-decay models; granularity of change matters; minimum 3 changes for stability.*

3. Tornhill, A. (2024). "Your Code as a Crime Scene, Second Edition." Pragmatic
   Bookshelf.
   *Function-level hotspots within files; 4% of code = 72% of defects.*

4. Hassan, A.E. (2009). "Predicting Faults Using the Complexity of Code Changes."
   ICSE 2009, pp. 78-88.
   *Entropy of changes at different granularities; change complexity > change size.*

5. Martin, R.C. (2002). "Agile Software Development: Principles, Patterns, and
   Practices." Prentice Hall.
   *Instability = Ce/(Ce+Ca); Stable Dependencies Principle.*

6. Nagappan, N. & Ball, T. (2007). "Using Software Dependencies and Churn Metrics
   to Predict Field Failures." ISSRE 2007.
   *Combined dependency + churn models outperform single-metric models.*

7. Shin, Y., Meneely, A., Williams, L., & Osborne, J. (2010). "Can CCC Metrics Be
   Used as Early Indicators of Vulnerabilities?" ACM SAC 2010.
   *Coupling, Cohesion, Complexity correlate with security vulnerabilities.*

8. Rebrö, D.A. (2023). "Source Code Metrics for Software Defects Prediction."
   arXiv:2301.08022.
   *Process metrics are strongest standalone predictors; combined models best.*
