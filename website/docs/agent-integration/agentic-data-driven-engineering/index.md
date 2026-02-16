---
title: "Agentic Data-Driven Engineering"
sidebar_position: 1
---

import AiQuery from '@site/src/components/AiQuery';

# Agentic Data-Driven Engineering

Standard code RAG retrieves by similarity: "find code that looks like X." The agent copies the first match without knowing if that code is stable, bug-prone, or has been rewritten five times. With trajectory enrichment, every search result carries [19 git-derived quality signals](/usage/git-enrichments) — and the agent can reason about **what to copy, what to avoid, and how to generate** before writing a single line.

This page is the practical guide: the five strategies, generation modes, danger zone checks, ripgrep verification, and ready-to-paste agent configurations. For the mental model behind this approach, see [How to Think with TeaRAGs](/agent-integration/mental-model). For metric interpretation and threshold tables, see [Deep Codebase Analysis](/agent-integration/deep-codebase-analysis). For preset/tool selection and custom weight strategies, see [Search Strategies](/agent-integration/search-strategies).

## The Five Strategies

### 1. Template Selection — What to Copy

The first search hit is not the best template. A function with 60% bug-fix rate "looks right" semantically but is the worst possible example to copy. Template selection should be driven by chunk-level quality signals, not similarity alone.

**Why chunk-level, not file-level:** A file may have `commitCount = 25` and `bugFixRate = 35%` — looks risky. But inside it, `formatReceipt()` has `chunkCommitCount = 1`, `chunkBugFixRate = 0%`, `chunkAgeDays = 120`. That function is a perfect template. File-level metrics would have hidden it. Always prefer chunk-level signals for template evaluation — see [decision guide](/agent-integration/deep-codebase-analysis#decision-guide).

<AiQuery>Find stable, low-churn implementations of request validation to use as a template</AiQuery>

<details>
<summary>Tool parameters</summary>

```json
{
  "query": "request validation pattern",
  "rerank": "stable",
  "pathPattern": "src/services/**",
  "limit": 10
}
```

</details>

**Quality criteria for a good template:**

| Signal | Good template | Mediocre | Avoid |
|--------|--------------|----------|-------|
| `chunkCommitCount` | 1-3 | 4-7 | > 8 |
| `chunkBugFixRate` | 0-15% | 15-35% | > 40% |
| `chunkAgeDays` | > 60 | 30-60 | < 14 |
| `churnVolatility` | < 5 | 5-15 | > 20 |
| `dominantAuthorPct` | > 70% | 40-70% | < 40% |

**The ideal template:** Low churn + old age + low bug rate + strong ownership = code that was written well the first time, survived production, and has a consistent style to follow.

### 2. Anti-Pattern Detection — What NOT to Copy

Equally important: find code that **should not** be used as a reference. These are functions that look right semantically but have a history of instability.

<AiQuery>Find high-churn, frequently-patched implementations of job processing</AiQuery>

<details>
<summary>Tool parameters</summary>

```json
{
  "query": "job processing workflow",
  "rerank": "hotspots",
  "limit": 10
}
```

</details>

**Red flags in search results:**

| Signal | Threshold | Problem |
|--------|-----------|---------|
| `chunkBugFixRate > 50%` | More than half of commits are fixes | Structurally fragile — patches don't stick |
| `chunkChurnRatio > 0.7` | One function absorbs 70%+ of file churn | This function is the root cause of the file's instability |
| `churnVolatility > 20` | Irregular bursts of patching | Reactive maintenance — "we only touch it when it breaks" |
| `relativeChurn > 5.0` | Code has been rewritten multiple times | Design problem, not implementation problem |

When the agent encounters an anti-pattern, it should note the specific issues — nested feature-flag checks, complex branching, mixed responsibilities — and explicitly avoid replicating them in generated code.

### 3. Style Consistency — Match the Domain Owner

Code generated in a vacuum passes tests but fails code review. The `dominantAuthor` signal tells the agent whose patterns to match.

<AiQuery>Find the dominant author and coding patterns in the workflow pipeline services</AiQuery>

<details>
<summary>Tool parameters</summary>

```json
{
  "query": "workflow pipeline service",
  "rerank": "ownership",
  "pathPattern": "src/services/workflow/**",
  "metaOnly": true,
  "limit": 15
}
```

</details>

**How to use ownership signals:**

| Ownership profile | Agent behavior |
|-------------------|----------------|
| `dominantAuthorPct > 80%`, `contributorCount = 1` | **Strong silo** — match this author's style exactly. Don't refactor, don't introduce new patterns. The author will review this code. |
| `dominantAuthorPct 50-80%`, `contributorCount = 2-3` | **Clear owner** — follow the dominant author's patterns with minor flexibility. |
| `dominantAuthorPct < 40%`, `contributorCount > 4` | **Shared area** — generate neutral, conventional code. Follow project-wide conventions rather than any single author's style. Opportunity to introduce unifying patterns. |

**What to match from the domain owner:**
- Error handling patterns (custom error classes vs generic rescue)
- Parameter extraction style (constructor vs method)
- Transaction boundaries and nesting
- Naming conventions for the specific domain

### 4. Historical Context — Why Code Exists

`taskIds` extracted from commit messages reveal the feature's evolution — critical context that similarity search cannot provide.

<AiQuery>Show metadata for workflow job services to understand feature context through ticket IDs</AiQuery>

<details>
<summary>Tool parameters</summary>

```json
{
  "query": "workflow job service",
  "pathPattern": "src/services/workflow/jobs/**",
  "metaOnly": true,
  "limit": 15
}
```

</details>

**Interpreting taskIds patterns:**

| Pattern | taskIds | Commits | Bug rate | Meaning | Agent action |
|---------|---------|---------|----------|---------|--------------|
| **Simple feature** | 1 | 1-2 | < 10% | Built once, works | Safe to refactor freely |
| **Evolving feature** | 4+ | 5+ | 15-30% | Multiple iterations | Read all tickets before modifying |
| **Bug-prone feature** | 1 | 3+  | > 50% | Harder than expected | Add defensive tests, check edge cases |
| **Coordinated change** | Shared across files | Any | Any | Multi-file feature | Modify all related files together |

**Shared taskIds across files** are the strongest coordination signal. If `move.rb` and `update.rb` share taskId `TD-72004`, changes to one likely require changes to the other. The agent should flag this before generating code that touches only one of the pair.

### 5. Risk Assessment — How to Modify Safely

When modifying existing code with high-risk signals, the agent should switch from "write the best code" to "write the safest change."

<AiQuery>Find legacy code with high bug-fix rates in the recurrence processing area</AiQuery>

<details>
<summary>Tool parameters</summary>

```json
{
  "query": "recurrence processing job creation",
  "rerank": "techDebt",
  "limit": 10
}
```

</details>

**Risk indicators and defensive actions:**

| Risk profile | Signals | Defensive strategy |
|-------------|---------|-------------------|
| **Legacy fragile** | `ageDays > 90` + `bugFixRate > 40%` + `commitCount > 5` | Use wrapper pattern — keep old code intact, add new code path behind feature flag. Gradual rollout: 10% → 50% → 100%. |
| **Knowledge silo + churn** | `dominantAuthorPct > 85%` + `chunkCommitCount > 5` | Request review from the owner before merging. Do not restructure without knowledge transfer. |
| **High blast radius** | `imports count > 10` + `chunkBugFixRate > 30%` | Stabilize first — fix existing bugs before adding features. Run full integration tests. |
| **Pathological churn** | `churnVolatility > 30` + `bugFixRate > 40%` | This code needs redesign, not patching. Propose a rewrite plan rather than incremental changes. |

:::warning
Never directly modify code with `ageDays > 90` + `bugFixRate > 50%` + `relativeChurn > 5.0`. This code has been rewritten multiple times and keeps breaking. Any new patch has a high probability of introducing another bug. Use a wrapper pattern or propose a rewrite.
:::
