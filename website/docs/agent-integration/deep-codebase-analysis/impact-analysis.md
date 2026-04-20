---
title: "Impact Analysis"
sidebar_position: 4
---

import AiQuery from '@site/src/components/AiQuery';

# Impact Analysis & Blast Radius

Estimating change impact through dependency analysis and combining multiple analytical passes.

## Blast Radius Estimation

### Using imports as a proxy

The `impactAnalysis` preset uses import count as a fan-out measure — files imported by many others have higher blast radius.

<AiQuery>Find shared utility modules ranked by import count, metadata only</AiQuery>

<details>
<summary>Tool parameters</summary>

```json
{
  "query": "shared utility module",
  "rerank": "impactAnalysis",
  "metaOnly": true,
  "limit": 20
}
```

</details>

### Combining blast radius with risk

High blast radius is only dangerous if the code is also unstable:

<AiQuery>Find database connection code ranked by import count, churn, and bug-fix rate</AiQuery>

<details>
<summary>Tool parameters</summary>

```json
{
  "query": "database connection configuration",
  "rerank": {
    "custom": {
      "similarity": 0.2,
      "imports": 0.3,
      "chunkChurn": 0.25,
      "bugFix": 0.25
    }
  },
  "metaOnly": true
}
```

</details>

**Risk matrix:**

| Blast Radius (imports) | Stability | Risk | Action |
|----------------------|-----------|------|--------|
| High (10+ importers) | Stable (`commitCount < 5`) | Low | Change carefully, but code is proven |
| High (10+ importers) | Unstable (`commitCount > 15`, `bugFixRate > 30%`) | Critical | Stabilize before adding features |
| Low (1-3 importers) | Unstable | Medium | Fix quality, blast radius is contained |
| Low (1-3 importers) | Stable | Minimal | Safe to modify |

## Combining Analyses: Multi-Step Workflows

Real analysis often combines multiple searches. Here's a full workflow for assessing a subsystem:

### Step 1: Broad discovery

<AiQuery>Find hotspot areas in payment processing, metadata only</AiQuery>

**Goal:** identify the riskiest files. Look at `commitCount`, `relativeChurn`, `bugFixRate`.

### Step 2: Drill into top hotspots

<AiQuery>Find the highest-churn functions in the payment module, ranked by chunk churn and bug-fix rate</AiQuery>

**Goal:** find the specific functions causing the churn. Look at `chunkChurnRatio`, `chunkBugFixRate`.

### Step 3: Assess ownership and risk

<AiQuery>Show ownership distribution for the payment module, metadata only</AiQuery>

**Goal:** identify knowledge silos. Look at `dominantAuthorPct`, `contributorCount`.

### Step 4: Measure blast radius

<AiQuery>Find payment module exports ranked by import count, metadata only</AiQuery>

**Goal:** understand what breaks if you change the hotspot. Look at `imports` count.

### Synthesizing results

Combine findings into a risk assessment:

```text
Payment Subsystem Analysis:

CRITICAL: src/payment/processor.ts
  - processPayment() — chunkChurnRatio: 0.79, bugFixRate: 55%
  - Owner: alice (92% of commits) — knowledge silo
  - 15 downstream importers — high blast radius
  - Recommendation: pair programming + incremental refactoring

WATCH: src/payment/validator.ts
  - relativeChurn: 3.2, bugFixRate: 25%
  - 3 contributors — healthy ownership
  - 4 importers — moderate blast radius
  - Recommendation: monitor, low priority

STABLE: src/payment/receipt.ts
  - commitCount: 2, bugFixRate: 0%
  - Good template for new payment features
```

## See Also

- [Agentic Data-Driven Engineering](/agent-integration/agentic-data-driven-engineering) — pre-generation danger zone checks, generation mode switching, ripgrep verification
- [Search Strategies](/agent-integration/search-strategies) — reranking presets, custom weight strategies, multi-tool cascade
- [Code Churn: Theory & Research](/knowledge-base/code-churn-research) — metric formulas, Nagappan mappings, academic references
- [Git Enrichments](/usage/advanced/git-enrichments) — all signals explained with environment variables
- [Filters](/usage/advanced/filters) — filter syntax, git churn filters, filterable fields
- [Use Cases](/usage/use-cases#git-enrichment-use-cases) — practical git enrichment scenarios
