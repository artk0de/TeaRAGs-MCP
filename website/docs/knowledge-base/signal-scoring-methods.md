---
title: "Signal Scoring Methods"
sidebar_position: 7
---

# Signal Scoring Methods

How does a code search engine decide that one result is more relevant than another? Raw numbers from git history — like "142 days old" or "23 commits" — are not directly comparable. They live on different scales, have different distributions, and carry different levels of reliability.

This article explains the **five scoring methods** that TeaRAGs uses to transform raw code metrics into meaningful, comparable scores. We build from the simplest concept (normalization) to the most sophisticated (adaptive bounds), using git metrics as a running example.

---

## 1. Normalization — Making Numbers Comparable

### Without Normalization

Imagine you want to rank code by a combination of age and commit count. You have three files:

| File | Age (days) | Commits | Raw sum |
|------|:-:|:-:|:-:|
| auth.ts | 142 | 23 | 165 |
| utils.ts | 10 | 48 | 58 |
| config.ts | 300 | 3 | 303 |

If you just add the raw numbers, `config.ts` wins — but only because age is measured in days (large numbers) while commits are small numbers. **Age dominates the score by accident of scale**, not because it's more important. Swapping to hours (142 × 24 = 3408) would change the ranking entirely.

### With Normalization

**Normalization** squeezes any number into the range **0 to 1**, where 0 means "minimum" and 1 means "maximum." The formula is:

$$
\text{normalized} = \min\!\Bigl(1,\;\frac{\text{value}}{\text{bound}}\Bigr)
$$

The **bound** is the upper limit — any value at or above it maps to 1.0.

Now the same three files:

| File | Age | age / 365 | Commits | commits / 50 | Sum |
|------|:-:|:-:|:-:|:-:|:-:|
| auth.ts | 142 | 0.39 | 23 | 0.46 | **0.85** |
| utils.ts | 10 | 0.03 | 48 | 0.96 | **0.99** |
| config.ts | 300 | 0.82 | 3 | 0.06 | **0.88** |

Both signals contribute fairly. `utils.ts` ranks highest because it genuinely has high activity, not because of unit scale.

### Example

If the bound for age is 365 days:

| Raw age (days) | Calculation | Normalized |
|:-:|:-:|:-:|
| 0 | 0 / 365 | **0.00** |
| 30 | 30 / 365 | **0.08** |
| 142 | 142 / 365 | **0.39** |
| 365 | 365 / 365 | **1.00** |
| 500 | min(1, 500/365) | **1.00** (clamped) |

### Inversion

Some signals are "better when lower." For example, **recency** — code that was modified recently (low age) should score high. We simply flip the result:

$$
\text{recency} = 1 - \text{normalize}(\text{ageDays},\; 365)
$$

| Age (days) | normalize(age, 365) | recency = 1 − normalized |
|:-:|:-:|:-:|
| 7 | 0.02 | **0.98** (very recent) |
| 142 | 0.39 | **0.61** |
| 300 | 0.82 | **0.18** (old) |

---

## 2. Weighted Scoring — Combining Multiple Signals

### Without Weighted Scoring

After normalization, you could simply average all signals:

| File | similarity | recency | churn | **Average** |
|------|:-:|:-:|:-:|:-:|
| auth.ts | 0.85 | 0.61 | 0.46 | **0.64** |
| utils.ts | 0.40 | 0.98 | 0.96 | **0.78** |

But this treats every signal as equally important. For a "tech debt" analysis, you care about code age and churn far more than how well it matches the search query. With equal weights, semantic similarity drowns out the signals that actually matter for the task.

### With Weighted Scoring

**Weighted scoring** lets each analysis preset prioritize different signals. A tech debt preset might give similarity only 20% influence, while churn and age get 15% each:

$$
\text{score} = \frac{\sum_{i}\; w_i \times s_i}{\sum_{i}\; |w_i|}
$$

where $w_i$ is the weight and $s_i$ is the signal value.

### Example: Tech Debt Preset

| Signal | Weight ($w$) | Value ($s$) | Contribution ($w \times s$) |
|--------|:-:|:-:|:-:|
| similarity | 0.20 | 0.85 | 0.170 |
| age | 0.15 | 0.70 | 0.105 |
| churn | 0.15 | 0.60 | 0.090 |
| bugFix | 0.15 | 0.40 | 0.060 |
| volatility | 0.10 | 0.30 | 0.030 |
| knowledgeSilo | 0.10 | 1.00 | 0.100 |
| density | 0.10 | 0.25 | 0.025 |
| blockPenalty | −0.05 | 0.00 | 0.000 |

$$
\text{score} = \frac{0.170 + 0.105 + 0.090 + 0.060 + 0.030 + 0.100 + 0.025 + 0.000}{0.20 + 0.15 + 0.15 + 0.15 + 0.10 + 0.10 + 0.10 + 0.05} = \frac{0.580}{1.00} = 0.58
$$

The weight sum is 1.0, so the division keeps the score in range. If weights don't sum to 1.0, the formula still normalizes correctly — it's the **ratios** between weights that matter, not their absolute values.

### Negative Weights

The `blockPenalty` signal uses a **negative weight** (−0.05). This means: when this signal is high, the score goes *down*. It's used to suppress low-quality code chunks that lack reliable git data.

---

## 3. Confidence Dampening — Trusting Reliable Data

### Without Dampening

Consider a search for bug-prone code. Three files come back:

| File | Commits | Bug fixes | Bug fix rate | Normalized |
|------|:-:|:-:|:-:|:-:|
| auth.ts | 50 | 20 | 40% | **0.40** |
| utils.ts | 2 | 1 | 50% | **0.50** |
| config.ts | 100 | 30 | 30% | **0.30** |

`utils.ts` ranks highest — but its 50% rate is based on just 2 commits. One of them happened to be a fix. That's not a pattern, that's noise. With 50 more commits, the rate would likely drop to 5%. **The ranking is dominated by statistically meaningless data.**

### With Dampening

**Confidence dampening** reduces a signal's strength when the underlying data is too sparse to be reliable. After dampening (threshold = 8):

| File | Bug fix rate | Commits | Dampening $(n/k)^2$ | Dampened score |
|------|:-:|:-:|:-:|:-:|
| auth.ts | 0.40 | 50 | 1.00 | **0.40** |
| utils.ts | 0.50 | 2 | 0.063 | **0.031** |
| config.ts | 0.30 | 100 | 1.00 | **0.30** |

Now `auth.ts` correctly ranks first. `utils.ts` is suppressed to near-zero because 2 commits provide almost no statistical confidence.

The formula is:

$$
\text{dampening} = \begin{cases}
1 & \text{if } n \geq k \\[4pt]
\left(\dfrac{n}{k}\right)^{\!2} & \text{if } n < k
\end{cases}
$$

where $n$ is the commit count and $k$ is the **confidence threshold**.

The final signal value is multiplied by this dampening factor:

$$
\text{dampened} = \text{signal} \times \text{dampening}
$$

### Why Quadratic?

The exponent of 2 (squaring) makes dampening **aggressive for low commit counts** but gentle near the threshold:

| Commits ($n$) | Threshold ($k$) | $n/k$ | $(n/k)^2$ | Effect |
|:-:|:-:|:-:|:-:|---|
| 1 | 8 | 0.125 | **0.016** | Signal almost eliminated |
| 2 | 8 | 0.250 | **0.063** | ~6% of full strength |
| 4 | 8 | 0.500 | **0.250** | Quarter strength |
| 6 | 8 | 0.750 | **0.563** | Half strength |
| 8 | 8 | 1.000 | **1.000** | Full strength |
| 20 | 8 | 2.500 | **1.000** | Full strength (clamped) |

A linear formula ($n/k$) would give 50% strength at 4 commits — too generous for such sparse data. The quadratic curve is stricter, reaching 50% only around 6 commits.

### Where Does the Threshold Come From?

The threshold $k$ is determined from **collection-wide statistics**. After indexing a codebase, TeaRAGs computes the 25th percentile (p25) of commit counts across all indexed chunks. This becomes the dampening threshold.

**Why p25?** It represents the boundary of "low data" — code below this threshold has fewer commits than 75% of the codebase, so its statistical signals are unreliable.

If collection stats are not yet computed (e.g., first search after indexing), each signal has a **fallback threshold** — a hardcoded safe default.

### Example

Given collection p25 = 8 commits:

| File | Bug Fix Rate | Commits | Dampening | Dampened Score |
|------|:-:|:-:|:-:|:-:|
| auth.ts | 40% → 0.40 | 50 | 1.00 | **0.40** |
| utils.ts | 50% → 0.50 | 2 | 0.063 | **0.031** |
| config.ts | 30% → 0.30 | 6 | 0.563 | **0.169** |

Despite having the highest raw bug fix rate (50%), `utils.ts` scores lowest after dampening — because 2 commits provide almost no statistical confidence.

---

## 4. Alpha-Blending — Chunk vs. File Granularity

### Without Alpha-Blending

TeaRAGs indexes code at two levels — files and chunks (functions/blocks). Suppose you search for bug-prone code and a file `payment.ts` has two functions:

| Level | Bug fix rate | Commits |
|-------|:-:|:-:|
| **File** (payment.ts) | 35% | 80 |
| **Chunk** (processRefund) | 100% | 1 |

Using chunk data only: `processRefund` scores 1.0 — but its 100% rate is based on a single commit (which happened to be a fix). Misleading.

Using file data only: `processRefund` scores 0.35 — accurate for the file, but ignores that this specific function might genuinely be different from the rest of the file.

Neither approach is right. We need a way to **gradually trust chunk data as it matures**.

### With Alpha-Blending

**Alpha-blending** mixes chunk and file values based on how mature and representative the chunk data is:

$$
\text{effective} = \alpha \times \text{chunk} + (1 - \alpha) \times \text{file}
$$

where $\alpha$ (alpha) is a blending factor between 0 and 1:

$$
\alpha = \min\!\Bigl(1,\;\underbrace{\frac{\text{chunkCommits}}{\text{fileCommits}}}_{\text{coverage}} \;\times\; \underbrace{\min\!\Bigl(1,\;\frac{\text{chunkCommits}}{3}\Bigr)}_{\text{maturity}}\Bigr)
$$

Alpha has two components:

1. **Coverage** = what fraction of the file's history does this chunk represent?
2. **Maturity** = does this chunk have enough commits to be statistically meaningful? (Threshold: 3 commits)

### Example

| Scenario | Chunk commits | File commits | Coverage | Maturity | $\alpha$ | Meaning |
|----------|:-:|:-:|:-:|:-:|:-:|---|
| New function | 1 | 50 | 0.02 | 0.33 | **0.007** | Almost pure file signal |
| Growing function | 5 | 50 | 0.10 | 1.00 | **0.100** | 10% chunk, 90% file |
| Mature function | 20 | 50 | 0.40 | 1.00 | **0.400** | Significant chunk influence |
| Dominant function | 45 | 50 | 0.90 | 1.00 | **0.900** | Mostly chunk signal |

### Why Maturity Matters

Without the maturity factor, a chunk with 1 commit in a file with 2 commits would get $\alpha = 0.5$ — equal weight to chunk and file data. But 1 commit tells us almost nothing. The maturity threshold of 3 prevents low-commit chunks from having outsized influence.

### When Chunk Data Is Missing

If a chunk has no git-specific data (e.g., the chunk was never individually tracked), $\alpha = 0$ and the formula falls back to pure file-level values. This is the safe default — file data is always available.

---

## 5. Adaptive Bounds — Adjusting to the Data

### Without Adaptive Bounds

In section 1, we used a fixed bound of 365 for age normalization. This works for a project that's about a year old. But consider two different projects:

**Young project** (2 months old):

| File | Age (days) | normalize(age, 365) |
|------|:-:|:-:|
| main.ts | 60 | 0.16 |
| utils.ts | 45 | 0.12 |
| config.ts | 30 | 0.08 |

All values are squeezed into 0.08–0.16. The age signal is practically useless — it can't distinguish files that are meaningfully different in age for this project.

**Old project** (5 years old):

| File | Age (days) | normalize(age, 365) |
|------|:-:|:-:|
| legacy.ts | 1800 | 1.00 (clamped) |
| core.ts | 900 | 1.00 (clamped) |
| api.ts | 400 | 1.00 (clamped) |

Everything clamps to 1.0. Again, no discrimination — you can't tell "5 years old" from "1 year old."

### With Adaptive Bounds

**Adaptive bounds** compute the normalization bound dynamically for each search query, based on the actual values in the result set:

$$
\text{bound} = \max\!\bigl(\text{p95}_{\text{batch}},\;\text{p95}_{\text{collection}} \;\text{or}\; \text{defaultBound}\bigr)
$$

The process:

1. **Collect** raw values from all results in the current search batch
2. **Compute p95** — the 95th percentile of those values
3. **Floor** with collection-level p95 (from pre-computed stats) or the hardcoded default bound

### Why p95 and Not Mean or Median?

The bound is the **denominator** in normalization: `value / bound`. The choice of statistic determines how values distribute across the [0, 1] range:

| Statistic | What happens | Problem |
|-----------|---|---|
| **Mean** | ~40-50% of values clamp to 1.0 | Upper half indistinguishable |
| **Median (p50)** | ~50% of values clamp to 1.0 | Half the results are identical |
| **p95** | Only ~5% of values clamp to 1.0 | 95% of values spread across [0, 1] |

p95 gives the best **discrimination** — almost all values get a unique position in the normalized range. Only true outliers (top 5%) are clamped, and those extreme values shouldn't distort the scale anyway.

### Why Floor with a Default?

The floor prevents pathological cases:

- **Tiny batch** (3 results): p95 is unreliable — flooring with the default keeps bounds sensible
- **Homogeneous batch** (all values similar): p95 would be very small, making normalization hypersensitive to noise
- **All zeros**: the default prevents division by zero

### Example

A search returns 10 results with `ageDays` values:

```
[5, 10, 20, 35, 50, 80, 120, 200, 300, 500]
```

| Method | Bound | normalize(200, bound) | normalize(50, bound) |
|--------|:-:|:-:|:-:|
| Fixed default (365) | 365 | 0.55 | 0.14 |
| p95 of batch (460) | 460 | 0.43 | 0.11 |
| Mean (132) | 132 | 1.00 ← clamped | 0.38 |
| Median (65) | 65 | 1.00 ← clamped | 0.77 |

With p95, both values get meaningful, distinguishable scores. With mean or median, the higher value is clamped to 1.0 — you lose the ability to tell "200 days" apart from "300 days."

---

## How It All Fits Together

Each raw signal value passes through a pipeline of these methods. Here's the complete flow:

```
Raw payload value (e.g., ageDays = 142, commitCount = 23)
│
├─ 1. Alpha-blending ──────── Merge chunk + file values
│     α = coverage × maturity
│     effective = α × chunk + (1−α) × file
│
├─ 2. Adaptive bounds ─────── Compute per-query bound
│     bound = max(batchP95, collectionP95 or default)
│
├─ 3. Normalization ────────── Scale to [0, 1]
│     normalized = min(1, effective / bound)
│     (optional: invert with 1 − normalized)
│
├─ 4. Confidence dampening ── Reduce unreliable signals
│     dampened = normalized × (commitCount / threshold)²
│
└─ 5. Weighted scoring ────── Combine into final score
      score = Σ(weight × signal) / Σ|weight|
```

Not every signal uses every method. The table below shows which methods apply to each signal.

---

## Appendix: Signal Method Matrix

### Git Signals

| Signal | Normalization | Adaptive Bound | Alpha-Blend | Dampening | Inversion | Dampening Fallback |
|--------|:-:|:-:|:-:|:-:|:-:|:-:|
| recency | ageDays / bound | 365 | blendSignal | — | 1 − ... | — |
| age | ageDays / bound | 365 | blendSignal | — | — | — |
| stability | commitCount / bound | 50 | blendSignal | — | 1 − ... | — |
| churn | commitCount / bound | 50 | blendSignal | — | — | — |
| bugFix | bugFixRate / bound | 100 | blendSignal | $(n/k)^2$ | — | 8 |
| volatility | churnVolatility / bound | 60 | — | $(n/k)^2$ | — | 8 |
| density | changeDensity / bound | 20 | blendSignal | $(n/k)^2$ | — | 5 |
| ownership | dominantAuthorPct / 100 | — | — | $(n/k)^2$ | — | 5 |
| knowledgeSilo | step function | — | blendSignal | $(n/k)^2$ | — | 5 |
| relativeChurnNorm | relativeChurn / bound | 5.0 | blendSignal | $(n/k)^2$ | — | 5 |
| burstActivity | recencyWeightedFreq / bound | 10.0 | blendSignal | — | — | — |
| chunkChurn | chunk.commitCount / bound | 30 | × alpha | — | — | — |
| chunkRelativeChurn | chunk.churnRatio / bound | 1.0 | × alpha | — | — | — |
| blockPenalty | — | — | 1 − alpha | — | — | — |

### Structural Signals

| Signal | Normalization | Adaptive Bound | Alpha-Blend | Dampening | Inversion |
|--------|:-:|:-:|:-:|:-:|:-:|
| similarity | passthrough (vector score) | — | — | — | — |
| chunkSize | (endLine − startLine) / bound | 500 | — | — | — |
| documentation | binary (0 or 1) | — | — | — | — |
| imports | imports.length / bound | 20 | — | — | — |
| pathRisk | binary (0 or 1) | — | — | — | — |

**Legend:**
- **Adaptive Bound** column shows the `defaultBound` (floor value); actual bound is computed per-query via p95
- **blendSignal** = full alpha-blending of chunk + file values
- **× alpha** = signal value multiplied directly by alpha (chunk-only signals)
- **1 − alpha** = inverse alpha (penalty for low-quality chunks)
- **Dampening Fallback** = hardcoded threshold used when collection stats are not yet available
