---
title: "Risk Assessment"
sidebar_position: 2
---

import AiQuery from '@site/src/components/AiQuery';

# Risk Assessment

Identifying risky, volatile, and security-sensitive code using TeaRAGs git-enriched signals.

## Hotspot Detection: The Two-Stage Approach

The [Hotspot Model (Tornhill 2024)](/knowledge-base/code-churn-research#hotspot-model-codescene) defines a hotspot as **Complexity x Change Frequency**. TeaRAGs approximates this with churn + volatility + bug-fix rate at function granularity.

### Stage 1: File-level scan

Start broad — find files with high churn:

<AiQuery>Find hotspot areas in core business logic, show metadata only</AiQuery>

<details>
<summary>Tool parameters</summary>

```json
{
  "query": "core business logic",
  "rerank": "hotspots",
  "metaOnly": true,
  "limit": 30
}
```

</details>

In the results, look at file-level signals:

| Signal | Threshold | Meaning |
|--------|-----------|---------|
| `commitCount >= 15` | High churn | File changes frequently |
| `relativeChurn >= 3.0` | High relative churn | Code has been substantially rewritten ([Nagappan threshold](/knowledge-base/code-churn-research#relativechurn)) |
| `bugFixRate >= 40%` | High fix rate | Many commits are patches, not features |
| `churnVolatility > 30` | Irregular bursts | Changes come in unpredictable waves |

### Stage 2: Chunk-level drill-down

For each hotspot file, search with chunk-level focus:

<AiQuery>Find functions with the highest churn and bug-fix rate in the payment module</AiQuery>

<details>
<summary>Tool parameters</summary>

```json
{
  "query": "error handling in payment processor",
  "rerank": {
    "custom": {
      "similarity": 0.2,
      "chunkChurn": 0.3,
      "bugFix": 0.3,
      "chunkRelativeChurn": 0.2
    }
  },
  "pathPattern": "**/payment/**"
}
```

</details>

Now interpret chunk-level results:

| Pattern | Diagnosis | Action |
|---------|-----------|--------|
| `chunkChurnRatio > 0.8` + `chunkBugFixRate > 50%` | This one function absorbs most of the file's churn and it's mostly bug fixes | Redesign this function — it's the root cause |
| `chunkChurnRatio > 0.8` + `chunkBugFixRate < 20%` | Function changes a lot but rarely for bug fixes | Active feature work — not a problem, just busy |
| `chunkChurnRatio < 0.1` + file `commitCount > 20` | Function is stable inside a churny file | Good template — reliable, battle-tested code |
| `chunkBugFixRate > 60%` + `chunkCommitCount < 5` | Few commits, but most are fixes | Fragile code — breaks easily, not churny enough to be a hotspot but still a quality problem |

### Real-world interpretation

A file `src/payment/processor.ts` with `commitCount = 28`, `bugFixRate = 35%` might contain:

- `processPayment()` — `chunkCommitCount = 22`, `chunkBugFixRate = 55%`, `chunkChurnRatio = 0.79` — **the hotspot**
- `validateCard()` — `chunkCommitCount = 4`, `chunkBugFixRate = 25%`, `chunkChurnRatio = 0.14` — normal maintenance
- `formatReceipt()` — `chunkCommitCount = 1`, `chunkBugFixRate = 0%`, `chunkChurnRatio = 0.04` — stable, good template

Without chunk-level metrics, the entire file looks like a hotspot. With them, you know exactly which function to fix.

## Churn Volatility: Healthy vs Pathological Change

Not all churn is bad. `churnVolatility` (standard deviation of days between commits) distinguishes regular development from erratic patching.

### Interpreting churnVolatility

| Volatility | Commit pattern | Interpretation |
|------------|---------------|----------------|
| `< 5` | Commits every few days, very regular | CI/CD-driven updates, scheduled maintenance |
| `5 - 15` | Mostly regular with occasional gaps | Normal sprint-based development |
| `15 - 30` | Mix of active periods and quiet periods | Feature-driven development — bursts during sprints |
| `> 30` | Long quiet periods interrupted by frantic patching | Reactive maintenance — "we only touch it when it breaks" |

### Combining volatility with other signals

<AiQuery>Find code with high volatility and high bug-fix rate in error handling</AiQuery>

<details>
<summary>Tool parameters</summary>

```json
{
  "query": "error handling retry logic",
  "rerank": {
    "custom": {
      "similarity": 0.3,
      "volatility": 0.3,
      "bugFix": 0.2,
      "chunkChurn": 0.2
    }
  }
}
```

</details>

**Diagnosis matrix:**

| Volatility | Bug Fix Rate | Diagnosis |
|------------|-------------|-----------|
| Low + Low | Stable, well-maintained | Leave it alone |
| Low + High | Regular bug fixes, predictable cadence | Systematic quality issue — needs redesign, not more patches |
| High + Low | Irregular changes, few fixes | Feature bursts — probably fine |
| High + High | Erratic patching, mostly bug fixes | **Pathological churn** — code breaks, gets patched, breaks again |

## Security Audit Surface

### Strategy: old + sensitive + under-owned

Security vulnerabilities concentrate in old code within sensitive paths, with few reviewers:

<AiQuery>Find old authentication and encryption code in security-sensitive paths using security audit ranking</AiQuery>

<details>
<summary>Tool parameters</summary>

```json
{
  "query": "authentication password encryption token session",
  "rerank": "securityAudit",
  "pathPattern": "{**/auth/**,**/security/**,**/crypto/**,**/session/**}",
  "limit": 20
}
```

</details>

### Prioritizing audit targets

| Signal combination | Audit priority | Reason |
|-------------------|----------------|--------|
| `ageDays > 365` + `dominantAuthorPct > 80%` + security path | Critical | Old code, one owner, security-sensitive — highest vulnerability risk |
| `ageDays > 180` + `bugFixRate > 30%` + security path | High | Old security code that keeps getting patched |
| `ageDays > 180` + `churnVolatility > 30` + security path | High | Irregular patching of old security code — reactive maintenance |
| `ageDays < 30` + multiple contributors + security path | Low | Recently written by multiple people — likely already reviewed |

<AiQuery>Find old authentication code with a single owner</AiQuery>
