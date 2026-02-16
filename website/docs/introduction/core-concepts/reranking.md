---
title: Reranking
sidebar_position: 5
---

Reranking re-scores search results using git metadata signals combined with task-specific weight profiles. Default semantic search returns results ranked by vector similarity only — but an agent investigating a production bug needs different results than an agent onboarding a new developer, even for the same query.

## How It Works

1. **Vector search** returns candidates ranked by embedding similarity
2. **Reranking** re-scores each result using a weighted combination of trajectory signals
3. **Final ranking** reflects both semantic relevance and code quality/history signals

## Presets

### For `search_code` (practical development)

| Preset | Signals | Best for |
|--------|---------|----------|
| `relevance` | similarity only | General code lookup (default) |
| `recent` | similarity 0.7 + recency 0.3 | Sprint review, incident response |
| `stable` | similarity 0.7 + stability 0.3 | Finding reliable implementations |

### For `semantic_search` / `hybrid_search` (analytics)

| Preset | Key signals | Best for |
|--------|-------------|----------|
| `relevance` | similarity only | General lookup (default) |
| `techDebt` | age + churn + bugFix + volatility | Legacy code assessment |
| `hotspots` | chunkChurn + burstActivity + bugFix + volatility | Bug-prone areas, risk assessment |
| `codeReview` | recency + burstActivity + density + chunkChurn | Recent changes review |
| `onboarding` | documentation + stability | New developer entry points |
| `securityAudit` | age + ownership + bugFix + pathRisk + volatility | Old critical code, security review |
| `refactoring` | chunkChurn + chunkSize + volatility + bugFix + age | Refactor candidates |
| `ownership` | ownership + knowledgeSilo | Knowledge silos, bus factor |
| `impactAnalysis` | similarity + imports | Dependency chains, blast radius |

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

**19 signals** are available for composition:

| Key | Signal Source | Description |
|-----|-------------|-------------|
| `similarity` | Vector search | Embedding similarity score |
| `recency` | git (prefers chunk-level) | Inverse of ageDays |
| `stability` | git (prefers chunk-level) | Inverse of commitCount |
| `churn` | git (prefers chunk-level) | Direct commitCount |
| `age` | git (prefers chunk-level) | Direct ageDays |
| `ownership` | git | Author concentration (dominantAuthorPct) |
| `chunkSize` | chunk metadata | Lines of code in chunk |
| `documentation` | chunk metadata | Is documentation file |
| `imports` | file metadata | Import/dependency count |
| `bugFix` | git (prefers chunk-level) | bugFixRate |
| `volatility` | git | churnVolatility (stddev of commit gaps) |
| `density` | git | changeDensity (commits/month) |
| `chunkChurn` | git chunk-level | chunkCommitCount |
| `relativeChurnNorm` | git | Churn relative to file size |
| `burstActivity` | git | recencyWeightedFreq — recent burst of changes |
| `pathRisk` | file metadata | Security-sensitive path pattern (0 or 1) |
| `knowledgeSilo` | git | Single-contributor flag (1 / 0.5 / 0) |
| `chunkRelativeChurn` | git chunk-level | Chunk's share of file churn |

All presets automatically prefer chunk-level data when available (e.g., `chunkCommitCount` over `commitCount` for churn signals).

## Combining Filters with Reranking

Filters (Qdrant conditions) **narrow** the candidate set. Reranking **re-orders** the filtered results. Use both for precise queries:

| Goal | Filter | Rerank |
|------|--------|--------|
| Recent bugs in auth | `git.ageDays <= 14` + `pathPattern: **/auth/**` | `hotspots` |
| Old single-owner code | `git.ageDays >= 90` + `git.commitCount >= 5` | `ownership` |
| Recently active TypeScript | `language: typescript` + `git.ageDays <= 30` | `codeReview` |
| Large stable functions | `chunkType: function` + `git.commitCount <= 3` | `onboarding` |

👉 **[Full agentic reranking workflows](/agent-integration/search-strategies)** — how agents chain presets for bug investigation, code review, refactoring, and more.
