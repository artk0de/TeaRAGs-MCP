---
title: Search Strategies
sidebar_position: 1
---

# Search Strategies for Agentic Flows

How AI agents (Claude, GPT, Gemini, custom LLM agents) can leverage tea-rags reranking presets and custom weights to get **task-appropriate** code search results instead of generic similarity matches.

## The Problem

Default semantic search returns results ranked by vector similarity only. But an agent investigating a production bug needs different results than an agent onboarding a new developer, even for the same query. Reranking solves this by re-scoring results using git metadata signals (churn, age, ownership, etc.) combined with task-specific weight profiles.

## Available Tools and Their Presets

### `search_code` (practical development)

| Preset | Signals | Best for |
|--------|---------|----------|
| `relevance` | similarity only | General code lookup (default) |
| `recent` | similarity 0.7 + recency 0.3 | Sprint review, incident response |
| `stable` | similarity 0.7 + stability 0.3 | Finding reliable implementations |

### `semantic_search` / `hybrid_search` (analytics)

| Preset | Key signals | Best for |
|--------|-------------|----------|
| `relevance` | similarity only | General lookup (default) |
| `techDebt` | age + churn + bugFix + volatility | Legacy code assessment |
| `hotspots` | chunkChurn + chunkRelativeChurn + burstActivity + bugFix + volatility | Bug-prone areas, risk assessment |
| `codeReview` | recency + burstActivity + density + chunkChurn | Recent changes review |
| `onboarding` | documentation + stability | New developer entry points |
| `securityAudit` | age + ownership + bugFix + pathRisk + volatility | Old critical code, security review |
| `refactoring` | chunkChurn + relativeChurnNorm + chunkSize + volatility + bugFix + age | Refactor candidates |
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

Available weight keys: `similarity`, `recency`, `stability`, `churn`, `age`, `ownership`, `chunkSize`, `documentation`, `imports`, `bugFix`, `volatility`, `density`, `chunkChurn`, `relativeChurnNorm`, `burstActivity`, `pathRisk`, `knowledgeSilo`, `chunkRelativeChurn`.
