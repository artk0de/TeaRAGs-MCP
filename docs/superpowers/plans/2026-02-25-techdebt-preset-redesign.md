# techDebt Reranking Preset Redesign

**Date:** 2026-02-25 **Status:** Approved **Task:** tea-rags-mcp-5oe
**Dependencies:** chunk-metric-corrections (9bc), chunk-file-interaction-model
(c48)

## 1. Problem Statement

The current `techDebt` preset uses 5 git signals with flat chunk-override-file
logic, binary blockPenalty, linear confidence, and static normalization bounds.
This produces unreliable rankings in monorepos (>1M LOC) due to:

1. Signal saturation (commitCount=300 and commitCount=51 both normalize to 1.0)
2. Small-sample over-trust (1-commit chunk overrides 100-commit file)
3. Missing risk dimensions (no knowledge silo, no sustained pressure, no chunk
   size)
4. Binary block penalty (no gradation between "no data" and "rich data")

## 2. Approach: Infrastructure-First (Approach B)

Implement reranker infrastructure improvements first, then redesign techDebt
weights. The infrastructure changes benefit ALL presets, not just techDebt.

### Infrastructure components (ordered by dependency):

| #   | Component                                 | Files                            | Lines changed |
| --- | ----------------------------------------- | -------------------------------- | ------------- |
| 1   | Per-signal quadratic confidence           | reranker.ts                      | ~30           |
| 2   | Laplace smoothing bugFixRate              | metrics.ts (file + chunk)        | ~8            |
| 3   | Size-dampened relativeChurn               | metrics.ts (chunk overlay)       | ~5            |
| 4   | Result-set adaptive bounds                | reranker.ts                      | ~40           |
| 5   | L3 alpha-blending + dataQualityDiscount   | reranker.ts                      | ~40           |
| 6   | Chunk temporal signals (commitTimestamps) | accumulator + metrics + reranker | ~30           |
| 7   | techDebt preset weights                   | reranker.ts                      | ~10           |

## 3. Revised techDebt Preset

### 3.1 Current weights

```typescript
techDebt: {
  similarity: 0.25,
  age: 0.2,
  churn: 0.2,
  bugFix: 0.15,
  volatility: 0.2,
  blockPenalty: -0.15,
}
```

### 3.2 Proposed weights

```typescript
techDebt: {
  similarity: 0.20,       // semantic relevance (reduced — debt is process-driven)
  age: 0.15,              // L3 blended old code
  churn: 0.15,            // L3 blended commit count
  bugFix: 0.15,           // L3 blended, Laplace-smoothed, quadratic k=8
  volatility: 0.10,       // file-native, quadratic k=8 (chunk deferred)
  knowledgeSilo: 0.10,    // NEW — single-contributor risk, quadratic k=5
  density: 0.10,          // NEW — sustained change pressure
  blockPenalty: -0.05,     // REDUCED — alpha model handles gradation
}
```

Sum of |weights| = 1.00.

### 3.3 Weight justification

**similarity 0.20** (was 0.25) Tech debt detection prioritizes process signals
over content match. 0.20 is sufficient to filter irrelevant results while giving
process signals 0.80 of total weight. Tornhill (2024): hotspot model =
complexity x frequency, not semantic similarity.

**age 0.15** (was 0.20) With L3 blending, `age` reflects weighted chunk+file
age, not just file-level. The signal is more precise, so less weight needed for
the same discriminating power. Freed 0.05 allocated to `knowledgeSilo`.

**churn 0.15** (was 0.20) Same reasoning as `age`. L3 blending makes the signal
more precise. Freed 0.05 allocated to `density` (sustained pressure).

**bugFix 0.15** (unchanged) Laplace smoothing (alpha=0.5) stabilizes the metric
at computation time. Quadratic confidence (k=8, p=2) dampens unreliable signals
at scoring time. Both corrections make 0.15 the right weight — the signal is now
trustworthy. Wilson 95% CI width at n=8 is ~0.33, acceptable for binary
proportion.

**volatility 0.10** (was 0.20) Reduced because: (a) file-level only (chunk
deferred — median chunk has 3 commits, stddev requires 3+ gaps), (b) `density`
captures complementary temporal dimension. Hassan (2009): change entropy
complementary to change frequency.

**knowledgeSilo 0.10** (NEW) Single-contributor code is a maintainability risk.
1 author = 1.0, 2 = 0.5, 3+ = 0. Quadratic confidence k=5 prevents 1-commit
chunks from showing as silos. Rebro (2023): contributor count is a top-3 process
metric for defect prediction.

**density 0.10** (NEW) `changeDensity = commitCount / spanMonths` measures
sustained activity pressure. Distinguishes between "10 commits in 1 week"
(burst, handled by burstActivity) and "10 commits over 10 months" (chronic
instability = debt). With chunk-level changeDensity (from commitTimestamps),
identifies specific churning methods.

**blockPenalty -0.05** (was -0.15) `dataQualityDiscount = 1 - alpha` replaces
binary flag. When alpha=0 (no chunk data), discount = 1.0 (full penalty). When
alpha=0.5, discount = 0.5. Continuous gradation makes a large negative weight
unnecessary. -0.05 is a light nudge for blocks with zero chunk data; the
alpha-dampened chunk-native signals do the rest.

### 3.4 Target detection patterns

| Pattern                        | Signals that detect it              | How                                                                                                               |
| ------------------------------ | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Old, still frequently changing | age (high) + churn (high)           | Both L3 blended; combined score high only when both are high                                                      |
| Oscillating logic              | volatility (high)                   | File-native, captures stddev of commit intervals                                                                  |
| Bug-fix heavy areas            | bugFix (high)                       | Laplace-smoothed rate, quadratic k=8                                                                              |
| Multi-author unstable          | knowledgeSilo (low!) + churn (high) | Low silo = many authors; high churn = instability. But debt also from silo=high (bus factor). Both cases captured |
| Large unstable chunks          | chunkSize via L3 churn blending     | Large chunks with high blended churn score high on `churn`; chunkSize not needed separately                       |
| Never-stabilized hotspots      | density (high) + age (high)         | Old code with sustained commits/month                                                                             |

### 3.5 Composite debtScore (deferred to Approach C)

An interaction term `debtIndex = age * churn` would capture "old AND churning"
directly, instead of relying on both being independently high. This requires a
new signal type in the scoring pipeline. Planned as a separate task.

## 4. Monorepo advantages

1. **Adaptive bounds**: p95 from result set eliminates saturation. In monorepo:
   core ORM with 300 commits gets meaningful score relative to utility with 15
   commits. Currently both saturate at 1.0.

2. **L3 blending**: A 1-commit chunk in a 200-commit file gets alpha=0.002,
   meaning 99.8% file signal + 0.2% chunk signal. Prevents noise from sparse
   chunk data dominating reliable file statistics.

3. **Quadratic confidence**: At n=2 commits, confidence = (2/8)^2 = 0.0625 for
   bugFix (was 0.4 linear). Binary proportions from 2 data points are
   effectively ignored.

4. **knowledgeSilo + density**: Critical in monorepos where bus factor and
   sustained change pressure are primary debt indicators. A single-author module
   changing 5x/month is higher debt risk than a 3-author module changing
   10x/month.

## 5. Backward compatibility

- No payload schema changes
- No API changes
- Old indexes (without chunk data): alpha=0, pure file signals, same as current
- Preset key `blockPenalty` retained (computation changes under the hood)
- All other presets unchanged (benefit from infrastructure, weights stay same)
