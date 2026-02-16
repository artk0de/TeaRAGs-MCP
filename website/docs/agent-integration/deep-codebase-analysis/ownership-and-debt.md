---
title: "Ownership & Tech Debt"
sidebar_position: 3
---

import AiQuery from '@site/src/components/AiQuery';

# Ownership, Tech Debt & Refactoring

Analyzing code ownership patterns, assessing technical debt severity, and identifying refactoring candidates.

## Ownership and Knowledge Silo Analysis

### Identifying bus-factor risks

<AiQuery>Find critical infrastructure code with ownership concentration, metadata only</AiQuery>

<details>
<summary>Tool parameters</summary>

```json
{
  "query": "critical infrastructure",
  "rerank": "ownership",
  "metaOnly": true,
  "limit": 30
}
```

</details>

**What to look for in results:**

| Signal | Risk level | Meaning |
|--------|-----------|---------|
| `dominantAuthorPct >= 90` + `contributorCount == 1` | Critical | Single person wrote and maintains this code |
| `dominantAuthorPct >= 70` + `contributorCount == 2` | High | One person dominates, one occasional contributor |
| `dominantAuthorPct < 50` + `contributorCount >= 4` | Low | Distributed ownership, healthy bus factor |

### Combining ownership with churn

The most dangerous combination: **knowledge silo + high churn + high bug-fix rate**. One person owns code that keeps breaking.

<AiQuery>Find single-owner code with high bug-fix rates in authentication</AiQuery>

<details>
<summary>Tool parameters</summary>

```json
{
  "query": "authentication authorization access control",
  "rerank": {
    "custom": {
      "similarity": 0.2,
      "knowledgeSilo": 0.3,
      "bugFix": 0.25,
      "chunkChurn": 0.25
    }
  },
  "pathPattern": "**/auth/**"
}
```

</details>

**Action matrix:**

| Ownership | Churn | Bug Fix Rate | Action |
|-----------|-------|-------------|--------|
| Silo (1 author) | High | High | Immediate risk — schedule pair programming, knowledge transfer |
| Silo (1 author) | Low | Low | Monitor — stable but still a bus factor |
| Distributed (4+ authors) | High | High | Quality problem but no knowledge risk |
| Distributed (4+ authors) | Low | Low | Healthy — no action needed |

## Tech Debt Assessment: Beyond Age

Tech debt is not just "old code." It's old code that **keeps requiring patches**. The `techDebt` preset captures this:

<AiQuery>Find legacy code older than 60 days with high churn in core domain, metadata only</AiQuery>

<details>
<summary>Tool parameters</summary>

```json
{
  "query": "core domain logic",
  "rerank": "techDebt",
  "filter": {
    "must": [{ "key": "git.ageDays", "range": { "gte": 60 } }]
  },
  "metaOnly": true,
  "limit": 30
}
```

</details>

### Scoring tech debt severity

Combine signals to assess severity — not all old code is debt:

| Pattern | Severity | Description |
|---------|----------|-------------|
| `ageDays > 180` + `commitCount > 15` + `bugFixRate > 40%` | Critical | Old code that keeps breaking and getting patched |
| `ageDays > 180` + `commitCount > 15` + `bugFixRate < 15%` | Low | Old code that changes for features, not fixes — active evolution |
| `ageDays > 180` + `commitCount < 3` + `bugFixRate = 0%` | None | Old stable code — not debt, just mature |
| `ageDays > 90` + `relativeChurn > 5.0` + `churnVolatility > 30` | High | Code has been substantially rewritten multiple times with irregular bursts |

### The relativeChurn advantage

Raw `commitCount` is misleading for debt assessment. A 2000-line utility file with 20 commits might be fine. A 50-line config file with 20 commits (`relativeChurn = 8.0+`) is a design problem.

Use `relativeChurn` for debt ranking:

| `relativeChurn` range | Interpretation |
|-----------------------|----------------|
| `< 0.5` | Stable, well-designed |
| `0.5 - 2.0` | Normal development activity |
| `2.0 - 5.0` | Moderate churn — review if `bugFixRate` is high |
| `> 5.0` | Code has been rewritten multiple times — strong debt signal |

This aligns with [Nagappan & Ball's finding](/knowledge-base/code-churn-research#why-relative-churn-beats-absolute-churn) that relative churn is the strongest single defect predictor.

## Refactoring Candidates: Size + Churn + Quality

The best refactoring candidates are **large functions** with **high chunk-level churn** and **high bug-fix rates**:

<AiQuery>Find large, high-churn request handlers and processors as refactoring candidates</AiQuery>

<details>
<summary>Tool parameters</summary>

```json
{
  "query": "request handler processor controller",
  "rerank": "refactoring",
  "metaOnly": true,
  "limit": 20
}
```

</details>

### Prioritization criteria

| Criterion | Metric | Why it matters |
|-----------|--------|----------------|
| Function size | `chunkSize` (lines) | Large functions are harder to understand and test |
| Chunk churn | `chunkChurnRatio` | If one function absorbs most of the file's churn, it needs splitting |
| Bug density | `chunkBugFixRate` | High fix rate = function is structurally fragile |
| Volatility | `churnVolatility` | Irregular bursts indicate reactive patching |
| Relative churn | `relativeChurn` | Size-normalized — [strongest defect predictor](/knowledge-base/code-churn-research#why-relative-churn-beats-absolute-churn) |

### Distinguishing refactoring from tech debt

Tech debt and refactoring overlap but serve different purposes:

| Analysis | Focus | Key signal | Goal |
|----------|-------|-----------|------|
| **Tech debt** (`techDebt` preset) | File age + accumulation | `ageDays` + `commitCount` + `bugFixRate` | Identify legacy code needing modernization |
| **Refactoring** (`refactoring` preset) | Function size + structure | `chunkChurnRatio` + `chunkSize` + `chunkBugFixRate` | Identify specific functions to split or redesign |

A 2-month-old 200-line function with 8 bug fixes is a **refactoring candidate** (young, badly structured) but not tech debt (not old). An 18-month-old file with steady patches is **tech debt** (accumulated cruft) but refactoring might target only one function within it.
