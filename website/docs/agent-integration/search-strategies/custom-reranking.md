---
title: Custom Reranking
sidebar_position: 4
---

import AiQuery from '@site/src/components/AiQuery';

# Custom Rerank Strategies

Preset reranking covers common scenarios, but **custom weights** unlock precise, task-specific analysis. The key is combining **orthogonal signals** — each weight should add unique information that the others don't have.

## Strategy 1: Multi-signal risk scoring

Combine orthogonal signals to create a composite risk score:

<AiQuery>Find code ranked by a combination of churn, bug fixes, blast radius, and volatility</AiQuery>

<details>
<summary>Tool parameters — "What should we test more?"</summary>

```json
{
  "rerank": {
    "custom": {
      "chunkChurn": 0.25,
      "bugFix": 0.3,
      "imports": 0.25,
      "volatility": 0.2
    }
  }
}
```

</details>

**Why this works:** `chunkChurn` identifies hot functions, `bugFix` adds quality signal, `imports` adds blast radius, `volatility` adds unpredictability. Each signal adds information the others don't have.

**Anti-pattern:** Don't combine `churn` + `chunkChurn` + `relativeChurnNorm` — these are all churn variants and will just triple-weight the same underlying signal.

## Strategy 2: Inverse scoring for safe code

Sometimes you need the **opposite** of a hotspot — stable, well-owned, low-bug code:

<AiQuery>Find stable, battle-tested implementations with distributed ownership to use as reference</AiQuery>

<details>
<summary>Tool parameters — "Safe reference code"</summary>

```json
{
  "rerank": {
    "custom": {
      "stability": 0.3,
      "age": 0.2,
      "similarity": 0.3,
      "ownership": 0.2
    }
  }
}
```

</details>

**Why this works:** `stability` (inverse of commitCount) boosts low-churn code. `age` (direct ageDays) boosts old code — old + stable = battle-tested. `ownership` boosts distributed authorship — multiple people reviewed this code.

## Strategy 3: Activity pulse

Track where active development is happening right now:

<AiQuery>Find code with recent burst activity and high change density</AiQuery>

<details>
<summary>Tool parameters — "Active development zones"</summary>

```json
{
  "rerank": {
    "custom": {
      "burstActivity": 0.4,
      "density": 0.3,
      "recency": 0.3
    }
  }
}
```

</details>

**Why this works:** `burstActivity` (recencyWeightedFreq) uses exponential decay — a commit from today counts ~10x more than one from 3 weeks ago. Combined with `density` (commits/month) and `recency`, this surfaces the most actively worked-on code.

**Use case:** Sprint planning — see where engineering effort is concentrated. Compare against roadmap priorities.

## Strategy 4: Cross-signal anomaly detection

Find unusual patterns that individual presets miss:

<AiQuery>Find code that is both a knowledge silo and a hotspot in security-sensitive paths</AiQuery>

<details>
<summary>Tool parameters — "Dangerous silos"</summary>

```json
{
  "rerank": {
    "custom": {
      "knowledgeSilo": 0.3,
      "chunkChurn": 0.25,
      "bugFix": 0.25,
      "pathRisk": 0.2
    }
  },
  "pathPattern": "{**/auth/**,**/payment/**,**/crypto/**}"
}
```

</details>

**Why this works:** No single preset combines silo risk + churn + security path. Custom weights let you search for this specific intersection — the most dangerous code in the codebase.

## Guidelines for building custom weights

| Guideline | Explanation |
|-----------|-------------|
| **Keep weights summing to ~1.0** | Weights are normalized internally, but 1.0 makes intent clearer |
| **Use 3-5 signals maximum** | More signals dilute each other — focus on what matters for this specific question |
| **Don't overlap signals** | `churn` + `chunkChurn` + `density` all measure change frequency — pick one |
| **Include `similarity` at 0.2-0.4** | Unless doing pure metadata analysis, some semantic relevance prevents nonsensical matches |
| **Test with `metaOnly: true` first** | See the scoring before downloading full code content |

## Signal Overlap Reference {#signal-overlap-reference}

Signals that measure similar things — avoid combining within the same custom rerank:

| Signal group | Members | Pick one |
|-------------|---------|----------|
| **Churn frequency** | `churn`, `chunkChurn`, `density`, `burstActivity` | `chunkChurn` for function-level, `burstActivity` for recency-weighted |
| **Churn magnitude** | `relativeChurnNorm`, `chunkRelativeChurn` | `chunkRelativeChurn` for function-level |
| **Age/freshness** | `age`, `recency` | `recency` if you want recent code, `age` if you want old code |
| **Ownership** | `ownership`, `knowledgeSilo` | `knowledgeSilo` for binary silo detection, `ownership` for gradient |

Signals that are **orthogonal** and combine well:

| Signal A | + Signal B | Combined meaning |
|----------|-----------|-----------------|
| `chunkChurn` | `bugFix` | Frequently changed + mostly bug fixes = quality problem |
| `knowledgeSilo` | `imports` | Single owner + many dependents = dangerous silo |
| `stability` | `age` | Low churn + old = battle-tested code |
| `burstActivity` | `pathRisk` | Recent activity in security paths = needs review |
| `chunkRelativeChurn` | `volatility` | Function absorbs disproportionate churn + irregular pattern = structural problem |

## Known Limitations

1. **Schema gap:** The `ScoringWeightsSchema` in the MCP tool definitions does not yet expose the newer weight keys (`relativeChurnNorm`, `burstActivity`, `pathRisk`, `knowledgeSilo`, `chunkRelativeChurn`). Agents using preset strings are unaffected; agents constructing custom weights for these signals will need the schema updated.

2. **No cross-search chaining:** Each search is independent. The agent must manually chain results from one search into filters for the next. There is no built-in "find all files that import results from my previous search."

3. **Git metadata required:** All reranking presets except `relevance` require `CODE_ENABLE_GIT_METADATA=true` during indexing. Without git enrichment, non-relevance presets silently degrade to similarity-only scoring.

4. **Chunk-level data is partial:** Chunk-level metrics (chunkCommitCount, chunkBugFixRate, etc.) are only available for files with multiple chunks and recent commits within the `GIT_CHUNK_MAX_AGE_MONTHS` window. Single-chunk files and old-only commits fall back to file-level metrics.

5. **No fan-in (importedBy) data yet:** The current `impactAnalysis` preset uses only fan-out (imports count). Fan-in metrics and the `blastRadius` preset are planned.
