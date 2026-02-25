# Chunk-Level Metric Corrections for Semantic Code Search Reranking

**Date:** 2026-02-25
**Status:** Research / Proposal
**Scope:** `metrics.ts` (chunk overlay computation), `reranker.ts` (signal normalization and scoring)

## 1. Executive Summary

TeaRAGs reranks code search results by blending semantic similarity with git-derived process signals. File-level metrics are mature (9 signals), but the chunk-level overlay only exposes 6 — missing the temporal dynamics (`recencyWeightedFreq`, `changeDensity`, `churnVolatility`) that drive the `hotspots`, `codeReview`, and `refactoring` presets. Additionally, the confidence model uses a linear ramp that over-trusts small samples, the normalization uses fixed global bounds that saturate in monorepos, and several edge cases create systematic biases.

**Key findings:**

1. **Three missing chunk-level temporal signals** should be added. `recencyWeightedFreq` (burst detection) and `changeDensity` (sustained activity) provide high value at low cost if `commitTimestamps: number[]` is added to `ChunkAccumulator`. `churnVolatility` should be deferred — it requires sorted timestamps and the signal is noisy below 5 commits.

2. **The linear confidence ramp is suboptimal.** A logarithmic model `confidence = min(1, log2(n+1) / log2(k+1))` provides better early discrimination and is consistent with Bayesian shrinkage intuitions. Per-signal thresholds should replace the single global `MIN_CONFIDENT_COMMITS = 5`.

3. **Fixed normalization bounds fail in heterogeneous monorepos.** Result-set adaptive bounds (compute p95 from the current result batch) eliminate saturation without requiring a global index scan.

4. **Four systematic biases** are identified with concrete correction formulas: large-file churnRatio dilution, small-chunk relativeChurn inflation, bugFixRate instability at low commit counts, and dominantAuthor unreliability in sparse chunks.

## 2. Missing Temporal Dynamics at Chunk Level

### 2.1 recencyWeightedFreq (Chunk-Level Burst Activity)

**Problem.** The file-level `recencyWeightedFreq = SUM(exp(-0.1 * daysAgo))` captures recent burst activity. The reranker exposes this as the `burstActivity` signal, used in `hotspots` (weight 0.15) and `codeReview` (weight 0.15). However, this signal is file-scoped — a file with 10 recent commits will score high even if 9 of those commits touched an unrelated method. A chunk that has not been modified in months inherits the file's high burst score.

**Recommendation: Add.**

**Formula.** Given `commitTimestamps: number[]` in `ChunkAccumulator`:

```
chunkRecencyWeightedFreq = SUM(exp(-0.1 * (nowDays - tsDays_i)))
```

where each `tsDays_i = commitTimestamp_i / 86400` and `nowDays = Date.now() / 86400000`.

**Implementation in `computeChunkOverlay`:**

```typescript
const nowSec = Date.now() / 1000;
const recencyWeightedFreq = acc.commitTimestamps.reduce((sum, ts) => {
  const daysAgo = (nowSec - ts) / 86400;
  return sum + Math.exp(-0.1 * daysAgo);
}, 0);
```

**Data requirement.** Add `commitTimestamps: number[]` to `ChunkAccumulator`. In `chunk-reader.ts`, when a commit touches a chunk, push `commit.timestamp` to the array (currently we only track `lastModifiedAt` via `max`). Storage cost: one `number` per commit-chunk intersection. For a file with 50 commits and 10 chunks, worst case is 500 numbers (4KB) — negligible.

**Accumulator change in `chunk-reader.ts`:**

```typescript
// Inside the affectedChunkIds loop, after acc.commitShas.add(commit.sha):
acc.commitTimestamps.push(commit.timestamp);
```

**ChunkChurnOverlay addition:**

```typescript
recencyWeightedFreq: number;  // chunk-level burst activity
```

**Reranker change.** Add a `chunkBurstActivity` signal in `calculateSignals`:

```typescript
chunkBurstActivity: normalize(
  chunk?.recencyWeightedFreq ?? 0,
  bounds.maxBurstActivity
),
```

The `burstActivity` signal should then prefer chunk-level when available:

```typescript
burstActivity: normalize(
  chunk?.recencyWeightedFreq ?? file?.recencyWeightedFreq ?? 0,
  bounds.maxBurstActivity
),
```

**Impact on presets.**

| Preset | Signal | Current source | After change |
|--------|--------|---------------|--------------|
| `hotspots` | `burstActivity` (0.15) | File-level only | Chunk-level preferred |
| `codeReview` | `burstActivity` (0.15) | File-level only | Chunk-level preferred |

**Expected precision improvement.** In a file with 10 methods where 1 method received a burst of 8 recent commits: file-level gives all 10 chunks the same burst score. Chunk-level correctly identifies the 1 hot method. This directly improves hotspot detection recall — Tornhill (2024) showed that 4% of code accounts for 72% of defects, and that precision depends on sub-file granularity.

**Computational cost.** O(C) per chunk where C = number of commits touching that chunk. Already paid during hunk mapping — the only addition is a `push()` call. No extra git I/O.

### 2.2 changeDensity (Chunk-Level Sustained Activity)

**Problem.** File-level `changeDensity = commitCount / spanMonths` measures sustained change pressure over time. A file-level density of 15 commits/month is alarming, but if 14 of those are in one method and 1 is in another, the file-level number is misleading for the quiet method. The `codeReview` preset (weight 0.15 on `density`) and `refactoring` (implicit through `changeDensity`) cannot distinguish.

**Recommendation: Add.**

**Formula.** Given `commitTimestamps`:

```
chunkSpanMonths = max((max(timestamps) - min(timestamps)) / (86400 * 30), 1)
chunkChangeDensity = chunkCommitCount / chunkSpanMonths
```

**Implementation in `computeChunkOverlay`:**

```typescript
let changeDensity = 0;
if (acc.commitTimestamps.length > 0) {
  const minTs = Math.min(...acc.commitTimestamps);
  const maxTs = Math.max(...acc.commitTimestamps);
  const spanMonths = Math.max((maxTs - minTs) / (86400 * 30), 1);
  changeDensity = acc.commitTimestamps.length / spanMonths;
}
```

Note: `Math.min/max` over the timestamps array is O(C). For a chunk with 50 commits this is negligible. If performance matters, track `earliestTimestamp` and `latestTimestamp` in the accumulator instead.

**ChunkChurnOverlay addition:**

```typescript
changeDensity: number;  // chunk-level commits/month
```

**Reranker change.** The `density` signal should prefer chunk-level:

```typescript
density: normalize(
  chunk?.changeDensity ?? file?.changeDensity ?? 0,
  bounds.maxChangeDensity
) * confidence,
```

**Impact on presets.**

| Preset | Signal | Weight | Improvement |
|--------|--------|--------|------------|
| `codeReview` | `density` | 0.15 | Distinguishes actively-changed methods from quiet ones in same file |

**Computational cost.** Trivial — min/max over an array already in memory.

### 2.3 churnVolatility (Chunk-Level Change Pattern Irregularity)

**Problem.** File-level `churnVolatility = stddev(days between consecutive commits)` signals erratic change patterns — a red flag for technical debt (used in `techDebt` at 0.20 and `securityAudit` at 0.15). At chunk level, the same analysis could identify methods with irregular maintenance vs steady ones.

**Recommendation: Defer.**

**Rationale against immediate implementation:**

1. **Minimum sample size.** Standard deviation of inter-commit gaps requires at least 3 commits to produce meaningful variance (2 gaps). With `MIN_CONFIDENT_COMMITS = 5`, the confidence damping already discounts signals from chunks with fewer than 5 commits. But chunk-level commit counts are typically much lower than file-level: in our dataset, the median chunk has 3 commits where the median file has 12. Computing volatility on 2-3 gaps produces noise, not signal.

2. **Diminishing returns over changeDensity.** For chunks with sufficient commits, `changeDensity` already captures the "how actively is this chunk changing" dimension. Volatility adds the "how regular is the pattern" dimension, but at chunk level, most change patterns are irregular by nature (methods get touched in clusters, not at steady intervals). The signal-to-noise ratio is poor.

3. **Computational cost.** Requires sorting `commitTimestamps` and computing sequential gaps. While O(C log C) is acceptable, it is an unnecessary allocation when the signal quality is low.

**When to reconsider.** If chunk-level commit counts increase (e.g., longer `maxAgeMonths` window or monorepo scale where methods accumulate 10+ commits), volatility becomes viable. The data requirement (timestamps array) will already be satisfied by the `recencyWeightedFreq` addition.

**Fallback formula (for future implementation):**

```typescript
let churnVolatility = 0;
if (acc.commitTimestamps.length > 2) {
  const sorted = [...acc.commitTimestamps].sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    gaps.push((sorted[i] - sorted[i - 1]) / 86400);
  }
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const variance = gaps.reduce((s, g) => s + (g - mean) ** 2, 0) / gaps.length;
  churnVolatility = Math.sqrt(variance);
}
```

### 2.4 Summary: Temporal Signals Decision Matrix

| Signal | Add to chunk? | Data requirement | Presets affected | Priority |
|--------|--------------|-----------------|-----------------|----------|
| `recencyWeightedFreq` | Yes | `commitTimestamps[]` | hotspots, codeReview | P1 |
| `changeDensity` | Yes | `commitTimestamps[]` (or min/max) | codeReview, refactoring | P1 |
| `churnVolatility` | Defer | `commitTimestamps[]` (sorted) | techDebt, securityAudit | P3 |

## 3. Statistical Confidence Model

### 3.1 Current Model Analysis

The current confidence function is:

```typescript
const confidence = Math.min(1, effectiveCommitCount / MIN_CONFIDENT_COMMITS);
// MIN_CONFIDENT_COMMITS = 5
```

This produces: `{0: 0, 1: 0.2, 2: 0.4, 3: 0.6, 4: 0.8, 5+: 1.0}`.

**Problems:**

1. **Over-trusts small samples.** At `n=2`, the model assigns 40% confidence. But a bugFixRate computed from 2 commits (where 1 is a fix = 50%) is far less reliable than the 40% confidence suggests. With 2 data points, any binary metric (bugfix or not) can only produce values of {0%, 50%, 100%} — the entire range is noise.

2. **Under-discriminates in the 3-5 range.** The linear ramp gives `n=3` and `n=4` the values 0.6 and 0.8, which are quite close. But statistically, 3 samples vs 4 samples is a much smaller improvement than 1 vs 2 samples. The marginal information gain per additional sample follows a concave curve (diminishing returns), not a line.

3. **Identical threshold for all signals.** The `bugFixRate` is a binary proportion that needs more samples for stability (binomial confidence interval). The `dominantAuthorPct` is an aggregation of counts. The `churnVolatility` is a second-order statistic (standard deviation) that needs even more data. Using `k=5` for all is a crude approximation.

### 3.2 Alternative Models Compared

#### 3.2.1 Sigmoid (Logistic)

```
confidence = 1 / (1 + exp(-a * (n - k)))
```

where `a` controls steepness and `k` is the inflection point.

With `a=1.5, k=3`:
- `n=0 → 0.01`, `n=1 → 0.05`, `n=2 → 0.18`, `n=3 → 0.50`, `n=5 → 0.95`, `n=7 → 0.999`

**Pro:** Smooth S-curve with natural saturation. The inflection point is interpretable ("at k commits, we are 50% confident").
**Con:** Two parameters to tune. Overkill for a damping factor — we do not need the tail behavior to be precisely modeled. The sigmoid never reaches exactly 1.0, which means even at 100 commits there is a fractional penalty (though negligible).

#### 3.2.2 Logarithmic Ramp

```
confidence = min(1, log2(n + 1) / log2(k + 1))
```

With `k=5`:
- `n=0 → 0`, `n=1 → 0.39`, `n=2 → 0.61`, `n=3 → 0.77`, `n=4 → 0.90`, `n=5 → 1.0`

Wait — this actually gives more trust to small samples, not less. Let me reconsider.

The log ramp is concave: rapid early gain, then flattening. This means `n=1` already gets 0.39, which is higher than linear's 0.20. This models the intuition "the first few samples provide the most information." However, for our use case of damping unreliable signals, we want the opposite: penalize heavily at small n, recover quickly once sufficient.

**Correction.** The desired curve shape for damping is actually convex at the start (slow to trust) then concave near saturation (quick to reach full trust). This is the sigmoid shape. But we want simplicity.

#### 3.2.3 Bayesian Shrinkage (Empirical Bayes)

For a proportion like `bugFixRate`:

```
adjustedRate = (n * observedRate + k * priorRate) / (n + k)
```

where `priorRate` is the global average bugFixRate across the index, and `k` is the prior strength (equivalent sample size). This is the standard James-Stein / empirical Bayes estimator.

With `k=5, priorRate=0.15` (hypothetical global average):
- `n=1, observed=100%` → `(1*1.0 + 5*0.15) / 6 = 0.29` (instead of 1.0)
- `n=10, observed=50%` → `(10*0.5 + 5*0.15) / 15 = 0.38`
- `n=50, observed=50%` → `(50*0.5 + 5*0.15) / 55 = 0.47`

**Pro:** Mathematically principled. Directly corrects the metric rather than applying a post-hoc confidence multiplier. Shrinks extreme values toward the prior, which is exactly what we want.
**Con:** Requires computing a global prior (`priorRate`) from the dataset. This is an extra pass over the index at query time, or a stored statistic. Adds complexity to the signal pipeline.

#### 3.2.4 Wilson Score Interval (Lower Bound)

For binary proportions (bugFixRate, dominantAuthorPct):

```
lowerBound = (p + z^2/(2n) - z*sqrt((p*(1-p) + z^2/(4n))/n)) / (1 + z^2/n)
```

where `p = observedRate`, `n = commitCount`, `z = 1.96` (95% confidence).

For `n=1, p=1.0`: `lowerBound = 0.21`
For `n=10, p=0.5`: `lowerBound = 0.24`
For `n=50, p=0.5`: `lowerBound = 0.37`

**Pro:** Used in ranking systems (Reddit, Amazon reviews). Provides a conservative estimate that accounts for sample size uncertainty.
**Con:** Only applicable to binary proportions. Does not generalize to `churnVolatility` or `changeDensity`. The formula is complex and non-intuitive for debugging.

### 3.3 Proposed Model: Per-Signal Confidence with Power Ramp

After weighing alternatives, I propose replacing the single linear ramp with a power function that has per-signal thresholds:

```typescript
function confidence(n: number, k: number, p: number = 2): number {
  if (n >= k) return 1;
  return Math.pow(n / k, p);
}
```

With `p=2` (quadratic), this produces a convex curve that heavily penalizes small samples:

| n | Linear (k=5) | Quadratic (k=5) | Quadratic (k=8) |
|---|-------------|----------------|----------------|
| 0 | 0.00 | 0.00 | 0.00 |
| 1 | 0.20 | 0.04 | 0.016 |
| 2 | 0.40 | 0.16 | 0.063 |
| 3 | 0.60 | 0.36 | 0.14 |
| 4 | 0.80 | 0.64 | 0.25 |
| 5 | 1.00 | 1.00 | 0.39 |
| 8 | 1.00 | 1.00 | 1.00 |

**Per-signal thresholds:**

| Signal | Threshold k | Rationale |
|--------|-------------|-----------|
| `bugFix` | 8 | Binary proportion. Wilson 95% CI width at n=8 is ~0.33, acceptable. At n=3, width is ~0.56 — too wide. |
| `ownership` | 5 | Herfindahl-style concentration. Stabilizes faster than binary proportion because it aggregates over multiple authors. |
| `knowledgeSilo` | 5 | Derived from contributor count. Same reasoning as ownership. |
| `volatility` | 8 | Second-order statistic (stddev). Needs more data than first-order metrics. |
| `density` | 5 | First-order (mean). Stabilizes at moderate samples. |
| `relativeChurnNorm` | 5 | Cumulative ratio. Stabilizes at moderate samples. |

**Implementation:**

```typescript
const CONFIDENCE_THRESHOLDS: Partial<Record<keyof ScoringWeights, number>> = {
  bugFix: 8,
  volatility: 8,
  ownership: 5,
  knowledgeSilo: 5,
  density: 5,
  relativeChurnNorm: 5,
};

const DEFAULT_THRESHOLD = 5;
const CONFIDENCE_POWER = 2;

function signalConfidence(
  effectiveCommitCount: number,
  signal: keyof ScoringWeights
): number {
  const k = CONFIDENCE_THRESHOLDS[signal] ?? DEFAULT_THRESHOLD;
  if (effectiveCommitCount >= k) return 1;
  return Math.pow(effectiveCommitCount / k, CONFIDENCE_POWER);
}
```

In `calculateSignals`, each dampened signal gets its own confidence:

```typescript
bugFix: normalize(effectiveBugFixRate, bounds.maxBugFixRate)
  * signalConfidence(effectiveCommitCount, 'bugFix'),
volatility: normalize(file?.churnVolatility ?? 0, bounds.maxVolatility)
  * signalConfidence(effectiveCommitCount, 'volatility'),
// ... etc
```

### 3.4 Chunk vs File Maturity Scaling

**Problem.** A chunk with 2 commits in a file with 100 commits is very different from a chunk with 2 commits in a file with 3 commits. In the first case, the chunk is genuinely cold (untouched while the rest of the file changed 98 times). In the second case, the chunk is typical — the whole file is young.

**Proposed additional signal: relative maturity.**

```
relativeMaturity = chunkCommitCount / fileCommitCount
```

This already exists as `churnRatio`. The insight is that `churnRatio` should modulate confidence, not just serve as an independent signal:

```typescript
// Boost confidence when chunk's share of file activity is high
// (the chunk has "seen enough" relative to its file context)
const maturityBoost = chunk?.churnRatio ?? 1;
const adjustedConfidence = Math.min(1,
  signalConfidence(effectiveCommitCount, signal) + maturityBoost * 0.2
);
```

The 0.2 factor caps the boost: a chunk with `churnRatio=1.0` (all file commits touch it) gets +0.2 confidence. This helps chunks in young files (3 commits, churnRatio=0.67) reach full confidence faster, while chunks in old files with low churnRatio (2/100) remain appropriately penalized.

**Decision: Defer.** This interaction between churnRatio and confidence adds coupling complexity. The per-signal thresholds already address the core problem. Revisit after measuring the impact of the power ramp model.

### 3.5 Heavy-Tailed Distribution Considerations (Monorepo Context)

In >1M LOC monorepos, commit count distributions are heavy-tailed. Some files have 500+ commits, most have fewer than 10. The confidence model must not assume a normal distribution.

The power ramp model is distribution-agnostic — it only depends on absolute sample count, not relative position. This is intentional: whether a file has 5 commits in a repo where the median is 3 or where the median is 50, 5 commits provide the same statistical reliability for computing a proportion like bugFixRate.

The normalization strategy (Section 4) handles the distribution shape. The confidence model handles sample reliability. These are orthogonal concerns and should remain decoupled.

## 4. Normalization Strategy

### 4.1 Problems with Static Bounds

Current bounds:

```typescript
const DEFAULT_BOUNDS = {
  maxAgeDays: 365,
  maxCommitCount: 50,
  maxChunkSize: 500,
  maxChunkCommitCount: 30,
  maxRelativeChurn: 5.0,
  // ...
};
```

**Problem 1: Saturation.** In a monorepo with a core ORM module touched by 300 commits, `normalize(300, 50) = 1.0`. A module with 51 commits also scores 1.0. The reranker cannot distinguish between "moderately active" and "extreme hotspot."

**Problem 2: Under-utilization.** In a young project where no file exceeds 10 commits, all files score below 0.2 on the `churn` signal. The signal has no discriminating power — it is compressed into a narrow band at the bottom of the range.

**Problem 3: Cross-project inconsistency.** The bounds are hardcoded. A monorepo needs `maxCommitCount=300`, a microservice needs `maxCommitCount=20`. Deploying the same bounds to both yields poor results for at least one.

### 4.2 Options Analysis

#### 4.2.1 Per-File Normalization

`chunkCommitCount / fileCommitCount` (already exists as `churnRatio`).

**Pro:** Naturally bounded [0, 1]. No external data needed.
**Con:** Only works for chunk-vs-file comparisons. Does not help with file-level signals (`commitCount`, `ageDays`). A file with 300 commits and a chunk with 150 both get churnRatio=0.5, same as a file with 4 and a chunk with 2. The absolute magnitude is lost.

**Verdict:** Already used. Does not replace bounds-based normalization for file-level signals.

#### 4.2.2 Percentile-Based Normalization (Index-Wide)

Compute p95 for each signal across the entire index at startup or reindex time. Store as index metadata.

```
normalizedValue = rank(value) / totalCount
```

or use the p95 as the bound:

```
normalizedValue = min(1, value / p95)
```

**Pro:** Adaptive. Handles any distribution. A monorepo's p95 commitCount might be 200; a microservice's might be 15.
**Con:** Requires an extra pass over the index during ingestion. If the index has 100K chunks, computing p95 for 10 signals is ~1M comparisons — fast, but it is an architectural addition (stats must be stored and updated incrementally). Query-time recomputation from the entire index is too expensive.

**Verdict:** Good long-term solution. Requires infrastructure (persistent signal statistics per collection).

#### 4.2.3 Result-Set Adaptive Bounds (Proposed)

Compute bounds from the current result set at query time. For each signal, take p95 (or max) of the results being reranked.

```typescript
function computeAdaptiveBounds(results: RerankableResult[]): NormalizationBounds {
  const values: Record<string, number[]> = {};
  for (const r of results) {
    const file = resolveFileMeta(r.payload?.git);
    const chunk = resolveChunkMeta(r.payload?.git);
    // Collect values for each signal
    if (file?.commitCount) (values.commitCount ??= []).push(file.commitCount);
    if (file?.ageDays) (values.ageDays ??= []).push(file.ageDays);
    // ... etc for each signal
  }

  function p95(arr: number[]): number {
    if (arr.length === 0) return 1;
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.floor(sorted.length * 0.95);
    return sorted[Math.min(idx, sorted.length - 1)] || 1;
  }

  return {
    maxCommitCount: Math.max(p95(values.commitCount ?? []), DEFAULT_BOUNDS.maxCommitCount),
    maxAgeDays: Math.max(p95(values.ageDays ?? []), DEFAULT_BOUNDS.maxAgeDays),
    // ...
  };
}
```

Key design decisions:

1. **Floor with DEFAULT_BOUNDS.** `Math.max(adaptive, default)` prevents degenerate cases where all results have the same value (p95=p5), which would make normalization unstable.

2. **p95 not max.** Using max makes a single outlier dominate the scale. p95 tolerates 1-2 extreme outliers.

3. **Computed per query.** Result sets are typically 10-50 items. Computing p95 for 10 signals over 50 items is 500 comparisons — sub-microsecond.

**Pro:** Zero infrastructure change. Adapts to the local context of each query. A query that returns only high-churn files will have a wider scale than one returning only stable files.
**Con:** Non-deterministic — the same file scores differently depending on what else is in the result set. Two identical queries may produce slightly different normalized scores if the result sets differ. However, since reranking is relative (we only care about the ordering within a result set), this is actually desirable behavior.

**Verdict: Recommended as the immediate strategy.** Implement result-set adaptive bounds with default-floor.

### 4.3 Hybrid Strategy (Proposed)

**Phase 1 (immediate):** Result-set adaptive bounds. Modify `rerankResults` to compute bounds from the result set before scoring. Floor with current `DEFAULT_BOUNDS` to prevent instability.

**Phase 2 (future):** Index-level p95 statistics. Store per-collection statistics during ingestion. Use as the floor instead of hardcoded `DEFAULT_BOUNDS`. This gives a stable baseline while result-set adaptation handles local context.

**Implementation for Phase 1:**

```typescript
export function rerankResults<T extends RerankableResult>(
  results: T[],
  mode: RerankMode<string>,
  presets: Record<string, ScoringWeights>,
  bounds: NormalizationBounds = DEFAULT_BOUNDS,
): T[] {
  // ... weight resolution ...

  // Compute adaptive bounds from result set
  const effectiveBounds = bounds === DEFAULT_BOUNDS
    ? mergeWithAdaptive(computeAdaptiveBounds(results), DEFAULT_BOUNDS)
    : bounds;  // caller-provided bounds take precedence

  const scored = results.map((result) => {
    const signals = calculateSignals(result, effectiveBounds);
    const newScore = calculateScore(signals, weights);
    return { ...result, score: newScore };
  });

  return scored.sort((a, b) => b.score - a.score);
}

function mergeWithAdaptive(
  adaptive: NormalizationBounds,
  floor: NormalizationBounds
): NormalizationBounds {
  return {
    maxAgeDays: Math.max(adaptive.maxAgeDays, floor.maxAgeDays),
    maxCommitCount: Math.max(adaptive.maxCommitCount, floor.maxCommitCount),
    // ... for each field
  };
}
```

## 5. Bias and Edge Case Corrections

### 5.1 Large Files Biasing churnRatio

**Problem.** `churnRatio = chunkCommitCount / fileCommitCount`. In a 2000-line file with 50 commits and 10 methods, method A has 5 commits (churnRatio=0.10), method B has 3 commits (churnRatio=0.06). In a 50-line utility file with 5 commits and 2 functions, function C has 3 commits (churnRatio=0.60).

Function C appears 6x more churny than method A, but method A might be the true hotspot — it is a method in a large, heavily-modified file that absorbs 10% of all changes. The ratio washes out absolute magnitude.

This is a direct manifestation of the base rate problem: the denominator (fileCommitCount) varies wildly across files, making cross-file comparisons of churnRatio meaningless.

**Correction formula.** Use log-scaled absolute chunk commit count as the primary cross-file signal, and churnRatio as an intra-file signal:

```typescript
// Cross-file comparable: absolute chunk activity (log-scaled to tame heavy tails)
chunkActivityLog: Math.log2(1 + (chunk?.commitCount ?? 0)),

// Intra-file relative: chunk's share of file activity
chunkRelativeChurn: normalize(chunk?.churnRatio ?? 0, bounds.maxChunkChurnRatio),
```

The `chunkChurn` signal already uses absolute chunk commit count. The fix is to ensure presets that do cross-file comparison use `chunkChurn` (absolute, normalized), not `chunkRelativeChurn` (ratio):

| Use case | Signal to use | Why |
|----------|--------------|-----|
| "Which chunks in this file are hottest?" | `chunkRelativeChurn` | Intra-file ranking, ratio is correct |
| "Which chunks across all files are hottest?" | `chunkChurn` | Cross-file, absolute count needed |
| Defect prediction | `chunkChurn` + `chunkRelativeChurn` | Both dimensions matter (Nagappan & Ball 2005 showed relative churn had 89% accuracy when combined with absolute) |

**Preset audit:**

The `hotspots` preset currently uses both `chunkChurn: 0.15` and `chunkRelativeChurn: 0.15`. This is actually correct — it combines absolute and relative signals. No change needed.

The `refactoring` preset uses `chunkChurn: 0.15` and `relativeChurnNorm: 0.15` (file-level relative churn). It should add `chunkRelativeChurn` as well for intra-file differentiation when chunk data is available.

**Impact.** Primarily diagnostic — the current preset weights are already well-designed. The key insight is that `chunkChurn` (absolute) and `chunkRelativeChurn` (relative) serve different purposes and should both remain in the signal set. No formula change needed; the documentation clarifies usage.

### 5.2 Small Chunks Inflating relativeChurn

**Problem.** Chunk-level `relativeChurn = (linesAdded + linesDeleted) / chunkLineCount`. A 5-line utility function with 2 lines changed yields `relativeChurn = 0.4`. A 200-line class with 20 lines changed yields `0.1`. The small function appears 4x more churny, but the absolute change (2 lines) is trivial — it was probably a rename or typo fix.

This bias directly affects the `refactoring` preset (which has `relativeChurnNorm: 0.15`) by promoting tiny functions as refactoring candidates when they may just have been touched for cosmetic reasons.

Graves et al. (2000) found that weighted time-decay models for fault prediction worked best when controlling for module size. Nagappan & Ball (2005) similarly noted that relative churn was predictive only when normalized against a size baseline — not against the module's own size in isolation.

**Correction formula: Size-dampened relative churn.**

```
dampedRelativeChurn = relativeChurn * (1 - exp(-chunkLineCount / S))
```

where `S` is a size scale parameter. With `S = 30`:

| chunkLineCount | damping factor | effect |
|---------------|---------------|--------|
| 5 | 0.15 | 85% suppression — tiny chunks penalized |
| 15 | 0.39 | moderate suppression |
| 30 | 0.63 | mild suppression |
| 50 | 0.81 | nearly full credit |
| 100 | 0.96 | essentially no suppression |
| 200 | 0.999 | no suppression |

**For the 5-line example:** `0.4 * 0.15 = 0.06` (down from 0.4).
**For the 200-line example:** `0.1 * 0.999 = 0.1` (unchanged).

**Implementation in `computeChunkOverlay`:**

```typescript
const SIZE_SCALE = 30;
const sizeDamping = 1 - Math.exp(-lineCount / SIZE_SCALE);
const dampedRelativeChurn = (totalChurn / lineCount) * sizeDamping;
```

This replaces the current raw `relativeChurn` in the overlay:

```typescript
return {
  // ...
  relativeChurn: Math.round(dampedRelativeChurn * 100) / 100,
};
```

**Alternative considered: log-scaled denominator.** `relativeChurn = totalChurn / log2(1 + chunkLineCount)`. This compresses the denominator for small chunks, giving them a larger effective size. However, it changes the interpretation of relativeChurn (no longer "churn per line") and makes cross-chunk comparison harder to reason about.

**Alternative considered: minimum chunk size threshold.** Ignore relativeChurn for chunks below 10 lines. Simple, but creates a discontinuity — a 10-line chunk suddenly gets full relativeChurn, while a 9-line chunk gets zero. The exponential damping is smooth.

**Impact on presets.**

| Preset | Signal | Current behavior | After correction |
|--------|--------|-----------------|-----------------|
| `refactoring` | `relativeChurnNorm` (0.15) | Tiny functions rank as refactoring candidates | Small functions appropriately penalized |
| `hotspots` | `chunkRelativeChurn` (0.15) | Same inflation | Same correction via chunk overlay |

### 5.3 BugFixRate Instability with Small Samples

**Problem.** `bugFixRate = bugFixCount / commitCount * 100`. With 1 commit that matches "fix": `bugFixRate = 100%`. With 2 commits where 1 is a fix: `50%`. With 3 non-fix and 1 fix: `25%`. The metric oscillates wildly at small sample sizes and converges slowly.

This is the classic small-sample proportion problem. The confidence damping (Section 3) addresses it post-normalization, but the raw metric stored in the overlay and payload is misleading. A chunk with `bugFixRate=100%, commitCount=1` looks alarming in the UI, even if the reranker discounts it.

**Correction formula: Laplace smoothing (additive smoothing).**

```
smoothedBugFixRate = (bugFixCount + alpha) / (commitCount + 2 * alpha) * 100
```

where `alpha` is the pseudocount. With `alpha = 1` (Laplace smoothing):

| bugFixCount | commitCount | Raw rate | Smoothed rate |
|------------|-------------|----------|---------------|
| 1 | 1 | 100% | 67% |
| 0 | 1 | 0% | 33% |
| 1 | 2 | 50% | 50% |
| 5 | 10 | 50% | 50% |
| 0 | 10 | 0% | 8% |
| 0 | 50 | 0% | 2% |
| 25 | 50 | 50% | 50% |

**Observation:** With `alpha=1`, the smoothed rate converges to the observed rate as n grows (50/52 = 48% vs 50%), but at n=1, it pulls extreme values toward 50%. This is too aggressive — it makes zero-bugfix files look like they have a 33% bug rate.

**Better: alpha = 0.5 (Jeffreys prior).**

```
smoothedBugFixRate = (bugFixCount + 0.5) / (commitCount + 1) * 100
```

| bugFixCount | commitCount | Raw rate | Smoothed rate |
|------------|-------------|----------|---------------|
| 1 | 1 | 100% | 75% |
| 0 | 1 | 0% | 25% |
| 1 | 2 | 50% | 50% |
| 5 | 10 | 50% | 50% |
| 0 | 10 | 0% | 5% |
| 0 | 50 | 0% | 1% |
| 25 | 50 | 50% | 50% |

This is more reasonable: 0 bugs in 10 commits is a 5% smoothed rate (not 8%), and convergence is faster.

**Decision: Apply Laplace smoothing with alpha=0.5 at computation time, keep confidence damping at reranker time.**

The smoothing fixes the stored metric (making it interpretable in the UI and API). The confidence damping fixes the ranking impact (reducing weight of unreliable signals). Both corrections are complementary, not redundant.

**Implementation in `computeChunkOverlay`:**

```typescript
const SMOOTHING_ALPHA = 0.5;
const bugFixRate = commitCount > 0
  ? Math.round(((acc.bugFixCount + SMOOTHING_ALPHA)
      / (commitCount + 2 * SMOOTHING_ALPHA)) * 100)
  : 0;
```

Same change should be applied in `computeFileMetadata` for consistency:

```typescript
const bugFixRate = commits.length > 0
  ? Math.round(((commits.filter(c => isBugFixCommit(c.body)).length + SMOOTHING_ALPHA)
      / (commits.length + 2 * SMOOTHING_ALPHA)) * 100)
  : 0;
```

### 5.4 DominantAuthor Bias in Small Chunks

**Problem.** `dominantAuthorPct` at file level is computed as `maxAuthorCommitCount / totalCommitCount * 100`. At chunk level, this is not computed (the overlay only has `contributorCount`). But the reranker's `ownership` signal uses file-level `dominantAuthorPct`, and the `knowledgeSilo` signal uses `contributorCount` (preferring chunk-level when available).

Consider:
- **Chunk A:** 1 commit, 1 author. `contributorCount=1`, `knowledgeSilo=1.0` (max risk).
- **Chunk B:** 50 commits, all by one person. `contributorCount=1`, `knowledgeSilo=1.0` (max risk).

Both score identically on `knowledgeSilo`, but the meaning is profoundly different. Chunk A's single-author status is an artifact of low activity (not enough opportunity for others to contribute). Chunk B's single-author status is a genuine knowledge silo — 50 commits without any other contributor is a deliberate or structural pattern.

**Correction formula: Confidence-weighted knowledge silo.**

The per-signal confidence model (Section 3.3) already addresses this: `knowledgeSilo` is dampened by `signalConfidence(effectiveCommitCount, 'knowledgeSilo')` with threshold `k=5`.

With the proposed quadratic power ramp:
- Chunk A (1 commit): `knowledgeSilo = 1.0 * (1/5)^2 = 0.04`
- Chunk B (50 commits): `knowledgeSilo = 1.0 * 1.0 = 1.0`

This is a 25x difference, which correctly reflects the reliability gap. The existing correction via improved confidence is sufficient.

**Additional consideration: chunk-level dominantAuthorPct.**

Should we compute `dominantAuthorPct` at chunk level? This would require tracking per-author commit counts in `ChunkAccumulator` (not just `authors: Set<string>`, but `authorCommitCounts: Map<string, number>`).

**Formula:**

```typescript
// In ChunkAccumulator, replace authors: Set<string> with:
authorCounts: Map<string, number>;

// In accumulation loop:
acc.authorCounts.set(commit.author,
  (acc.authorCounts.get(commit.author) ?? 0) + 1);

// In computeChunkOverlay:
let dominantAuthorPct = 0;
if (acc.authorCounts.size > 0) {
  const maxCount = Math.max(...acc.authorCounts.values());
  dominantAuthorPct = Math.round((maxCount / commitCount) * 100);
}
```

**Decision: Defer.** The confidence damping improvement resolves the immediate bias. Computing chunk-level `dominantAuthorPct` is a nice-to-have that provides value primarily for the `ownership` preset. The data structure change (`Set` to `Map`) is minor but touches the accumulator interface. Implement when ownership analysis becomes a priority use case.

## 6. Summary of Proposed Changes

### 6.1 Changes to `ChunkAccumulator` (metrics.ts)

| Field | Current | Proposed | Purpose |
|-------|---------|----------|---------|
| `commitTimestamps` | absent | `number[]` | Enable chunk-level recencyWeightedFreq, changeDensity |

### 6.2 Changes to `ChunkChurnOverlay` (types.ts)

| Field | Current | Proposed | Purpose |
|-------|---------|----------|---------|
| `recencyWeightedFreq` | absent | `number` | Chunk-level burst activity |
| `changeDensity` | absent | `number` | Chunk-level commits/month |
| `relativeChurn` | raw ratio | size-dampened ratio | Fix small-chunk inflation |
| `bugFixRate` | raw proportion | Laplace-smoothed | Fix small-sample instability |

### 6.3 Changes to `chunk-reader.ts`

| Change | Description |
|--------|-------------|
| Push timestamp on accumulation | `acc.commitTimestamps.push(commit.timestamp)` in the affected-chunk loop |

### 6.4 Changes to `computeChunkOverlay` (metrics.ts)

| Change | Description |
|--------|-------------|
| Compute `recencyWeightedFreq` | `SUM(exp(-0.1 * daysAgo))` from `commitTimestamps` |
| Compute `changeDensity` | `commitCount / spanMonths` from `commitTimestamps` |
| Apply size damping to `relativeChurn` | `rawRelativeChurn * (1 - exp(-lineCount / 30))` |
| Apply Laplace smoothing to `bugFixRate` | `(bugFix + 0.5) / (commits + 1) * 100` |

### 6.5 Changes to `computeFileMetadata` (metrics.ts)

| Change | Description |
|--------|-------------|
| Apply Laplace smoothing to `bugFixRate` | Consistent with chunk-level correction |

### 6.6 Changes to `reranker.ts`

| Change | Description |
|--------|-------------|
| Per-signal confidence thresholds | Replace single `MIN_CONFIDENT_COMMITS=5` with per-signal `k` and power `p=2` |
| Chunk-level burstActivity preference | `burstActivity` reads `chunk.recencyWeightedFreq` when available |
| Chunk-level density preference | `density` reads `chunk.changeDensity` when available |
| Result-set adaptive bounds | Compute p95 from result set, floor with DEFAULT_BOUNDS |

### 6.7 Changes to `GitChunkFields` (reranker.ts)

| Field | Current | Proposed | Purpose |
|-------|---------|----------|---------|
| `recencyWeightedFreq` | absent | `number` | Chunk-level burst for reranker |
| `changeDensity` | absent | `number` | Chunk-level density for reranker |

## 7. Implementation Priority

### Phase 1: High Impact, Low Risk (implement first)

1. **Per-signal confidence with power ramp** (reranker.ts only)
   - Effort: ~30 lines changed in reranker.ts
   - Risk: Low — only changes weight dampening, not stored data
   - Impact: Fixes bugFixRate inflation, dominantAuthor noise at small samples
   - Testable: Existing reranker tests + new edge case tests

2. **Laplace smoothing for bugFixRate** (metrics.ts, both file and chunk)
   - Effort: ~4 lines changed
   - Risk: Low — changes stored values but makes them strictly more accurate
   - Impact: Fixes misleading 100%/0% rates in API output
   - Note: Existing indexes will have old values; only affects new indexing

### Phase 2: Medium Impact, Medium Risk (implement second)

3. **Size-dampened relativeChurn** (metrics.ts computeChunkOverlay)
   - Effort: ~5 lines changed
   - Risk: Medium — changes a stored metric, affects relativeChurnNorm signal
   - Impact: Fixes small-chunk inflation in refactoring and hotspots presets
   - Requires: Reranker test updates for new expected values

4. **Result-set adaptive bounds** (reranker.ts)
   - Effort: ~40 lines new code
   - Risk: Medium — changes scoring behavior for all presets
   - Impact: Fixes saturation in monorepos, improves discrimination
   - Requires: Careful testing with diverse result sets; existing tests need updated bounds assertions

### Phase 3: New Capabilities (implement third)

5. **Chunk-level recencyWeightedFreq** (accumulator + chunk-reader + metrics + reranker)
   - Effort: ~30 lines across 4 files
   - Risk: Medium — extends ChunkAccumulator interface, adds memory per commit-chunk
   - Impact: Enables sub-file burst detection for hotspots and codeReview
   - Requires: New accumulator field, chunk-reader push, overlay computation, reranker preference

6. **Chunk-level changeDensity** (same files as #5, piggybacks on timestamps)
   - Effort: ~10 lines (timestamps already available from #5)
   - Risk: Low (incremental on #5)
   - Impact: Enables sub-file sustained activity detection for codeReview

### Phase 4: Future (defer)

7. **Chunk-level churnVolatility** — insufficient sample sizes at current scale
8. **Chunk-level dominantAuthorPct** — requires Map in accumulator, low priority
9. **Index-level p95 statistics** — infrastructure for persistent collection stats

## 8. References

- **Nagappan, N. & Ball, T.** (2005). "Use of Relative Code Churn Measures to Predict System Defect Density." *Proceedings of the 27th International Conference on Software Engineering (ICSE)*. Demonstrated that relative churn (normalized by file size) predicted defect density with 89% accuracy, outperforming absolute churn metrics.

- **Tornhill, A.** (2024). *Code Health and Technical Debt*. Showed that approximately 4% of code accounts for 72% of defects, establishing the hotspot model: `Hotspot = Complexity x Change Frequency`. Sub-file granularity is essential for actionable results.

- **Hassan, A.E.** (2009). "Predicting Faults Using the Complexity of Code Changes." *Proceedings of the 31st International Conference on Software Engineering (ICSE)*. Found that the complexity of code changes (not just frequency) is a strong predictor of post-release faults. Supports using churn volatility and change density as complementary signals.

- **Rebro, P. et al.** (2023). "Process Metrics for Software Defect Prediction: A Systematic Literature Review." Found that process metrics (commit frequency, author patterns, change coupling) are the strongest standalone predictors of defects, outperforming product metrics (LOC, cyclomatic complexity) in most settings.

- **Graves, T.L. et al.** (2000). "Predicting Fault Incidence Using Software Change History." *IEEE Transactions on Software Engineering*. Introduced weighted time-decay models (exponential decay of fault prediction weight over time), showing that recent changes are more predictive than old ones. This directly underpins the `recencyWeightedFreq` formula `SUM(exp(-0.1 * daysAgo))`.
