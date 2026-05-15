---
title: Reranking
sidebar_position: 5
---

Reranking re-scores search results using git metadata signals combined with
task-specific weight profiles. Default semantic search returns results ranked by
vector similarity only — but an agent investigating a production bug needs
different results than an agent onboarding a new developer, even for the same
query.

## How It Works

1. **Vector search** returns candidates ranked by embedding similarity
2. **Reranking** re-scores each result using a weighted combination of
   trajectory signals
3. **Final ranking** reflects both semantic relevance and code quality/history
   signals

## Presets

Each preset declares the tools it supports via a `tools: []` field. Most presets
work across `search_code`, `semantic_search`, and `hybrid_search`;
development-focused presets are narrower.

### Development-focused

| Preset      | Signals                                   | Best for                           |
| ----------- | ----------------------------------------- | ---------------------------------- |
| `relevance` | similarity only                           | General code lookup (default)      |
| `recent`    | similarity + recency                      | Sprint review, incident response   |
| `stable`    | similarity + stability                    | Finding reliable implementations   |
| `proven`    | similarity + stability + low bug-fix rate | Templates that survived production |

### Analytical (risk, review, audit)

| Preset          | Key signals                                        | Best for                                   |
| --------------- | -------------------------------------------------- | ------------------------------------------ |
| `techDebt`      | age + churn + bugFix + volatility                  | Legacy code assessment                     |
| `hotspots`      | chunkChurn + burstActivity + bugFix + volatility   | Bug-prone areas, risk assessment           |
| `dangerous`     | bugFix + volatility + pathRisk                     | High-risk code in security-sensitive paths |
| `bug-hunt`      | bugFix + chunkChurn + recency                      | Actively bug-fixed, recently touched code  |
| `codeReview`    | recency + burstActivity + density + chunkChurn     | Recent changes review                      |
| `onboarding`    | documentation + stability                          | New developer entry points                 |
| `securityAudit` | age + ownership + bugFix + pathRisk + volatility   | Old critical code, security review         |
| `refactoring`   | chunkChurn + chunkSize + volatility + bugFix + age | Refactor candidates                        |
| `ownership`     | ownership + knowledgeSilo                          | Knowledge silos, bus factor                |

:::note

Blast-radius-only reranking (previously `impactAnalysis`) was removed in favour
of custom weight combinations. For dependency/blast-radius queries, use
`rerank: { custom: { similarity: 0.5, imports: 0.5 } }`.

:::

### Custom Weights

Any signal can be combined with arbitrary weights:

```json
{
  "rerank": {
    "custom": {
      "similarity": 0.4,
      "burstActivity": 0.3,
      "bugFix": 0.2,
      "pathRisk": 0.1
    }
  }
}
```

## Available Scoring Signals

**20+ signals** are available for composition (14 derived from git + 7
structural):

| Key                  | Signal Source             | Description                                   |
| -------------------- | ------------------------- | --------------------------------------------- |
| `similarity`         | Vector search             | Embedding similarity score                    |
| `recency`            | git (prefers chunk-level) | Inverse of ageDays                            |
| `stability`          | git (prefers chunk-level) | Inverse of commitCount                        |
| `churn`              | git (prefers chunk-level) | Direct commitCount                            |
| `age`                | git (prefers chunk-level) | Direct ageDays                                |
| `ownership`          | git                       | Live-line owner concentration (`blameDominantAuthorPct` — `git blame HEAD`)  |
| `recentActivityConcentration` | git              | Recent-commit concentration (`recentDominantAuthorPct` — recent commit window) |
| `chunkSize`          | chunk metadata            | Lines of code in chunk                        |
| `documentation`      | chunk metadata            | Is documentation file                         |
| `imports`            | file metadata             | Import/dependency count                       |
| `bugFix`             | git (prefers chunk-level) | bugFixRate                                    |
| `volatility`         | git                       | churnVolatility (stddev of commit gaps)       |
| `density`            | git                       | changeDensity (commits/month)                 |
| `chunkChurn`         | git chunk-level           | chunkCommitCount                              |
| `relativeChurnNorm`  | git                       | Churn relative to file size                   |
| `burstActivity`      | git                       | recencyWeightedFreq — recent burst of changes |
| `pathRisk`           | file metadata             | Security-sensitive path pattern (0 or 1)      |
| `knowledgeSilo`      | git                       | Single-contributor flag (1 / 0.5 / 0)         |
| `chunkRelativeChurn` | git chunk-level           | Chunk's share of file churn                   |

All presets automatically prefer chunk-level data when available (e.g.,
`chunkCommitCount` over `commitCount` for churn signals).

:::note Two ownership families
`ownership` and `knowledgeSilo` derive from `git.file.blame*` (live-line
ownership via `git blame HEAD`) — best for authority and bus-factor
questions. `recentActivityConcentration` derives from `git.file.recent*`
(recent commit window) — best for review routing and activity hotspots. When
the long-time owner has stopped committing, `blame*` and `recent*` disagree,
and the divergence itself signals a knowledge handoff in progress.
:::

## Confidence-Aware Signals

Some signals are **ratios** or **small-sample aggregates** where the value
is statistically unreliable when the underlying sample is small. Reading
`bugFixRate=67%` as "this file is dangerously buggy" makes sense when
there were 200 commits; with 3 commits, 2/3 produces the same 67% but is
just noise.

To avoid agents over-reading small-sample noise, confidence-aware signals
declare a **support sibling** (typically `commitCount`) that gates how
much the signal contributes to ranking and which overlay label it surfaces.

### Two consumers, one declaration

A confidence-aware signal declares ONE block that drives both:

- **Score dampening** — derived-signal contribution is multiplied by
  `(supportValue / k)²` (capped at 1). Small samples score lower; large
  samples pass through unchanged. `k` is read **adaptively** from the
  support signal's percentile distribution at query time, so the
  dampening curve scales with the codebase rather than a hardcoded
  constant.
- **Label clamp** — overlay label is capped (less-severe ceiling) when
  support is below a per-rule threshold. Raw `value` in overlay is
  preserved; only the bin (label) shifts. Clamp thresholds support
  adaptive forms (`whenSupportBelow: "pN"` reads percentile of support
  from collection stats) with static `fallback` for stale-index cases.

The result: an agent reading `bugFixRate: { value: 67, label: "healthy" }`
in overlay knows the sample size doesn't support a higher-severity bin,
without having to cross-reference `commitCount` manually.

### Current confidence-aware signals

| Raw signal        | Support       | Score dampening | Label clamp                          |
| ----------------- | ------------- | --------------- | ------------------------------------ |
| `bugFixRate`      | `commitCount` | adaptive p25    | `<p10 → healthy`, `<p25 → concerning` (per-codebase percentiles) |
| `churnVolatility` | `commitCount` | adaptive p25    | none                                 |
| `relativeChurn`   | `commitCount` | adaptive p25    | none                                 |
| `changeDensity`   | `commitCount` | adaptive p25    | none                                 |
| `recentDominantAuthorPct` | `commitCount` | adaptive p25 | none                            |
| `blameDominantAuthorPct`  | `commitCount` | adaptive p25 | none                            |
| `blameContributorCount`   | `commitCount` | adaptive p25 | none                            |

Score dampening applies to all 7 confidence-aware signals; label clamp
is currently only declared for `bugFixRate` (the signal most prone to
agent misread on small-N).

### Reading confidence-clamped overlays

When you see `{ value, label }` in overlay, the label has ALREADY been
clamped if the support sibling was low. Trust the label. If you read raw
`value` directly, pair it with the support's overlay label
(`commitCount.label`) — at "low" or below, treat the value as suggestive,
not diagnostic. See the agent-facing
[interpretation anti-pattern #8](../../agent-integration/signal-interpretation.md)
for the full rule.

### Lazy backfill of confidence percentiles

The adaptive `pN` references (score `adaptivePercentile`, label rule
`whenSupportBelow: "pN"`) need the corresponding percentile of the
support signal to be present in collection stats. After a full index,
all referenced percentiles are present. After a **descriptor change**
that adds a new `pN` reference, the existing index is stale relative
to the new declaration — the percentile is missing on disk.

Tea-rags handles this transparently: the first rerank that consults a
missing reference triggers a **single-percentile scroll** of the
support signal across the collection, computes the percentile,
mutates the in-memory stats in place (every other field of the
support's `SignalStats` is preserved exactly), and persists back to
the stats-cache snapshot. No full reindex required.

Properties of the backfill:

- **Lazy at rerank time.** Similarity-only presets (`relevance`) never
  trigger work; they early-return before the coverage check.
- **One scroll per support signal.** If a single signal has multiple
  missing percentiles referenced by different rules, they share one
  scroll and one sort.
- **One save per rerank.** Multiple signals backfilled across the
  same call commit to disk in a single atomic snapshot write.
- **Concurrent reranks dedup.** In-flight memo per
  `(collection, signal)` — two queries that both trigger backfill of
  the same support produce ONE scroll, not two.
- **Idempotent.** Subsequent reranks see the freshly populated
  percentile in memory and skip the scroll path entirely.
- **Graceful degradation.** If the scroll fails (Qdrant unavailable
  for that signal), the label path falls back to `rule.fallback` and
  the score path to `confidence.score.threshold` — the query still
  returns, just with the less-precise static threshold. A 60s
  per-signal backoff prevents retry storms.

The full design is in
`docs/superpowers/specs/2026-05-15-lazy-percentile-recompute-design.md`.

## Combining Filters with Reranking

Filters (Qdrant conditions) **narrow** the candidate set. Reranking
**re-orders** the filtered results. Use both for precise queries:

| Goal                       | Filter                                          | Rerank       |
| -------------------------- | ----------------------------------------------- | ------------ |
| Recent bugs in auth        | `git.ageDays <= 14` + `pathPattern: **/auth/**` | `hotspots`   |
| Old single-owner code      | `git.ageDays >= 90` + `git.commitCount >= 5`    | `ownership` (live-line) |
| Sole recent driver         | `git.ageDays <= 30` + `git.file.recentContributorCount == 1` | `recentActivityConcentration` |
| Recently active TypeScript | `language: typescript` + `git.ageDays <= 30`    | `codeReview` |
| Large stable functions     | `chunkType: function` + `git.commitCount <= 3`  | `onboarding` |

👉 **[Full agentic reranking workflows](/agent-integration/search-strategies)**
— how agents chain presets for bug investigation, code review, refactoring, and
more.
