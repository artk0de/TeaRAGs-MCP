---
title: "Prompt Examples"
sidebar_position: 5
---

# Prompt Examples

Ready-to-paste agent configuration blocks for deep codebase analysis workflows.

## Hotspot & Risk Analysis

````markdown
## Hotspot Detection

When investigating code quality or stability:
1. Broad scan: `semantic_search` with `rerank: "hotspots"`, `metaOnly: true`, `limit: 20`
2. Drill down: for top results, use `semantic_search` with `pathPattern` targeting that area

### Threshold Decision Table

| Signal           | Safe  | Caution | Stop     |
|------------------|-------|---------|----------|
| chunkBugFixRate  | < 15% | 15–40%  | > 40%    |
| chunkCommitCount | 1–3   | 4–7     | > 8      |
| churnVolatility  | < 5   | 5–20    | > 20     |

Action: Critical hotspots need redesign, not patches.
````

## Ownership & Knowledge Silo Detection

````markdown
## Ownership Analysis

To find knowledge silos:
1. `semantic_search` with `rerank: "ownership"`, `metaOnly: true`
2. Cross-reference ownership with hotspots for risk assessment

### Ownership Decision Table

| dominantAuthorPct | Status           | Action                              |
|-------------------|------------------|-------------------------------------|
| < 70%             | Well-distributed | Safe to modify freely               |
| 70–85%            | Partial silo     | Match dominant author's style       |
| > 85%             | Knowledge silo   | Flag owner for review before change |

### Risk Cross-Reference

| Silo? | Hotspot? | Risk   | Action                          |
|-------|----------|--------|---------------------------------|
| No    | No       | Low    | Safe to modify                  |
| No    | Yes      | Medium | Add tests, careful review       |
| Yes   | No       | Medium | Notify owner, match their style |
| Yes   | Yes      | High   | Escalate — redesign discussion  |
````

## Tech Debt Assessment

````markdown
## Tech Debt Discovery

To find legacy code that needs attention:
1. `semantic_search` with `rerank: "techDebt"`, `metaOnly: true`, `limit: 30`
2. Filter for confirmed debt: `git.ageDays >= 90` AND `git.commitCount >= 5`
3. Cross with hotspots: `semantic_search` with `rerank: "hotspots"`, same pathPattern

### Severity Decision Table

| chunkAgeDays | chunkBugFixRate | chunkCommitCount | Severity |
|--------------|-----------------|------------------|----------|
| > 90         | > 40%           | > 10             | HIGH     |
| > 60         | > 25%           | any              | MEDIUM   |
| > 90         | any             | < 3              | LOW      |
````

## Blast Radius Estimation

````markdown
## Blast Radius Check

Before modifying a module:
1. `semantic_search` with `rerank: { custom: { imports: 0.7, similarity: 0.3 } }`, `metaOnly: true`
2. Count imports in results — high imports = many dependents
3. Overlay risk: `semantic_search` with `rerank: "hotspots"` on dependent files

### Risk Decision Table

| Dependents | Hotspot? | Action                         |
|------------|----------|--------------------------------|
| < 5        | No       | Safe to modify                 |
| < 5        | Yes      | Modify with tests              |
| 5–15       | No       | Careful, run integration tests |
| 5–15       | Yes      | Needs design review            |
| > 15       | Any      | Propose RFC before changing    |
````

## Combined Multi-Step Analysis

````markdown
## Deep Analysis Workflow

For thorough codebase assessment. All steps use `semantic_search` with `metaOnly: true`, `limit: 20`.

### Analysis Steps

| Step | Action                 | Rerank preset    |
|------|------------------------|------------------|
| 1    | Discover relevant code | `relevance`      |
| 2    | Assess risk            | `hotspots`       |
| 3    | Map ownership          | `ownership`      |
| 4    | Estimate blast radius  | `custom weights (imports)` |

Synthesize: code that appears in hotspots AND silos AND has high blast radius is highest priority.
````

:::tip
Combine these prompt blocks with the reranking presets from [Search Strategies](/agent-integration/search-strategies) for maximum effectiveness. The presets handle the scoring math; these workflows tell your agent when and how to apply them.
:::
