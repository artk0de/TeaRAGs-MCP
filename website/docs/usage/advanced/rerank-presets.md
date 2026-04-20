---
title: Rerank Presets
sidebar_position: 4
---

# Rerank Presets

TeaRAGs ships **15 rerank presets** — named weight combinations over git and
structural signals. Every search tool accepts `rerank: "<preset>"`. Presets are
composable: you can also pass custom weights (`rerank: { custom: {...} }`) to
build your own.

## Quick Reference

| Preset | Description | Best for | Tools |
|--------|-------------|----------|-------|
| `relevance` | Pure semantic similarity | Default lookup | All |
| `recent` | Boost recently modified code | Sprint review, incident response | `search_code`, `semantic_search`, `hybrid_search`, `find_similar` |
| `stable` | Boost low-churn, long-lived code | Reliable implementations | Same as above |
| `proven` | Battle-tested: long-lived + multi-author + low-bug | Reference/template code | `search_code`, `semantic_search`, `hybrid_search` |
| `onboarding` | Documented, stable, multi-author | New-developer entry points | `semantic_search`, `hybrid_search`, `find_similar` |
| `hotspots` | High churn + high bug-fix + burst activity | Bug-prone areas | `semantic_search`, `hybrid_search`, `rank_chunks`, `find_similar` |
| `bugHunt` | Burst + volatility + relative churn + bug-fix history | Root-cause investigation | `search_code` + above |
| `dangerous` | Bug-prone + volatile + single-owner | High-risk code audit | `semantic_search`, `hybrid_search`, `rank_chunks`, `find_similar` |
| `techDebt` | Old + churning + bug-fixed | Legacy code assessment | Same as above |
| `securityAudit` | Old critical code in sensitive paths | Security review | `semantic_search`, `hybrid_search`, `find_similar` |
| `codeReview` | Recent + burst + density + chunk churn | Reviewing recent changes | `semantic_search`, `hybrid_search`, `rank_chunks`, `find_similar` |
| `refactoring` | Large + volatile + bug-fixed chunks | Refactor candidates | Same as above |
| `ownership` | Single dominant author | Knowledge silos, bus factor | Same as above |
| `decomposition` | Large, dense methods | Candidates for decomposition | Same as above |
| `documentationRelevance` | Boost docs by heading relevance | Doc search | `semantic_search`, `hybrid_search` |

## Development-Focused

Use these for day-to-day work — writing code, understanding an area, onboarding.

### `relevance`

Pure semantic similarity. `similarity: 1.0` — no trajectory signals. The default.

### `recent`

```
similarity:0.5 · recency:0.2 · burstActivity:0.15 · density:0.1 · churn:0.05
```

Boosts actively developed code. Use after an incident ("what changed recently
near the bug?") or when reviewing sprint work.

### `stable`

```
similarity:0.45 · stability:0.2 · age:0.15 · bugFix:-0.15 · volatility:-0.1 · ownership:0.05
```

Prefers low-churn, long-lived code. Negative weight on `bugFix` — code that keeps
breaking is penalized.

### `proven`

```
similarity:0.2 · stability:0.3 · age:0.3 · bugFix:-0.15 · ownership:-0.1 · volatility:-0.05
```

Stricter than `stable`: heavily weighs age and stability, penalizes single-owner
code (multi-author = better template). Use to find **reference implementations**.

### `onboarding`

```
similarity:0.3 · documentation:0.2 · stability:0.2 · age:0.1 · ownership:-0.1 · volatility:-0.1
```

Prioritizes documented, stable code with shared ownership. Actively **avoids**
single-owner hotspots — they confuse newcomers.

## Risk & Analysis

Identify problematic zones. All four presets work with `rank_chunks` — no query
required, just rank by signal.

### `hotspots`

```
similarity:0.2 · chunkSize:0.1 · chunkChurn:0.15 · chunkRelativeChurn:0.15
burstActivity:0.15 · bugFix:0.1 · volatility:0.15 · blockPenalty:-0.15
```

Classic risk signal: frequently-changing bug-prone code. Used by
`/tea-rags:risk-assessment`.

### `bugHunt`

```
similarity:0.25 · burstActivity:0.2 · volatility:0.2 · relativeChurnNorm:0.15
bugFix:0.15 · recency:0.05 · blockPenalty:-0.05
```

Tuned for active investigation: weighs recent burst activity and volatility
higher. Used by `/tea-rags:bug-hunt`.

### `dangerous`

```
bugFix:0.35 · volatility:0.25 · knowledgeSilo:0.2 · burstActivity:0.1 · similarity:0.1
```

High-risk code: bug-prone AND volatile AND single-owner. The intersection of
three danger signals. Low `similarity` weight — signal dominates over relevance.

### `techDebt`

```
similarity:0.15 · age:0.15 · churn:0.1 · chunkChurn:0.1 · bugFix:0.15
volatility:0.1 · knowledgeSilo:0.1 · density:0.1 · blockPenalty:-0.05
```

Old code that keeps accumulating patches. Unlike `hotspots`, weighs `age` — new
churny code isn't tech debt yet.

### `securityAudit`

```
similarity:0.25 · age:0.15 · ownership:0.1 · bugFix:0.1 · chunkChurn:0.1
pathRisk:0.15 · volatility:0.15
```

`pathRisk` = security-sensitive path pattern (auth, crypto, permissions). Combine
with `pathPattern: "**/auth/**"` for tighter scoping.

## Review & Change

### `codeReview`

```
similarity:0.3 · recency:0.15 · burstActivity:0.1 · density:0.1
chunkChurn:0.15 · chunkRelativeChurn:0.1 · blockPenalty:-0.1
```

Recent activity with churn context. Use before opening PRs to see what's actively
being touched in the area.

### `refactoring`

```
similarity:0.15 · chunkSize:0.3 · chunkDensity:0.1 · chunkChurn:0.15
chunkRelativeChurn:0.1 · volatility:0.1 · bugFix:0.05 · age:0.05 · blockPenalty:-0.1
```

Large + churning chunks. `chunkSize` is the top signal — small stable functions
aren't refactor candidates even if they have bug fixes. Groups by
`parentSymbolId` so multiple chunks of the same class/method cluster.

### `decomposition`

```
similarity:0.4 · chunkSize:0.4 · chunkDensity:0.2
```

Pure structural — no git. Large dense methods that should be split. Useful when
git history is sparse (new project) or git enrichment is disabled.

## Ownership

### `ownership`

```
similarity:0.35 · ownership:0.3 · knowledgeSilo:0.25 · chunkChurn:0.1
```

Surfaces single-dominant-author code. `knowledgeSilo` flag is 1 for solo owner,
0.5 for duopoly, 0 for shared.

## Documentation

### `documentationRelevance`

```
similarity:0.5 · headingRelevance:0.3 · documentation:0.2
```

Boosts docs by heading relevance (how well the query matches the nearest
heading). Use for querying markdown-heavy projects.

## Custom Weights

Compose your own preset by passing weights directly:

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

Any signal keys from the [git signal catalog](./git-enrichments) or structural
signals (`chunkSize`, `documentation`, `imports`, `pathRisk`, `headingRelevance`)
can be combined. Weights need not sum to 1.0 — they are normalized internally.

### Signal keys

See [Reranking concepts](/introduction/core-concepts/reranking#available-scoring-signals)
for the full list of 20+ signal keys and their descriptions.

## Signal Level

Some presets are `signalLevel: "file"` — they intentionally use file-level
signals (ownership, age) because chunk-level would be too noisy. Others use
chunk-level when available (churn, bug-fix rate per function).

File-level presets: `proven`, `ownership`, `onboarding`, `securityAudit`.
All others prefer chunk-level data when present, falling back to file-level.

## See Also

- [MCP Tools Atlas](./mcp-tools) — which tools accept which presets
- [Git Enrichments](./git-enrichments) — raw signal descriptions
- [Core Concepts: Reranking](/introduction/core-concepts/reranking) — how the
  scoring math works
