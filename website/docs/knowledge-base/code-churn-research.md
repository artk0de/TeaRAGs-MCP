---
title: "Code Churn: Theory & Research"
sidebar_position: 6
---

# Code Churn: Theory & Research

Code churn metrics quantify how frequently and intensively code changes over time. Research shows that churn is one of the strongest predictors of software defects ([Nagappan & Ball 2005](https://doi.org/10.1145/1062455.1062514), [Munson & Elbaum 1998](https://doi.org/10.1109/ICSM.1998.738486)).

This page covers the academic foundations behind the git-derived signals that tea-rags computes. For practical usage — filtering, reranking, environment variables — see [Git Enrichments](/usage/git-enrichments). For pipeline implementation details, see [Git Enrichment Pipeline](/architecture/git-enrichment-pipeline).

## Why Relative Churn Beats Absolute Churn

Nagappan & Ball (ICSE 2005) studied Windows Server 2003 and found that absolute metrics (raw commit count, raw lines changed) are **poor** defect predictors. Relative metrics — churn normalized by file size, component size, or time — achieved **89% accuracy** discriminating fault-prone from clean binaries. tea-rags implements this insight:

| tea-rags metric | Corresponding Nagappan metric | Type |
|-----------------|-------------------------------|------|
| `relativeChurn` | ChurnedLOC / TotalLOC | Relative (size-normalized) |
| `changeDensity` | ChurnCount / Months | Relative (time-normalized) |
| `chunkChurnRatio` | ChunkChurn / FileChurn | Relative (scope-normalized) |
| `commitCount` | Raw churn count | Absolute (weaker signal) |

## Hotspot Model (CodeScene)

Adam Tornhill's empirical work showed that **Hotspot = Complexity x Change Frequency** identifies the most defect-dense code. In a 400 KLOC study: 4% of code accounted for 72% of defects. tea-rags approximates this through the `hotspots` preset (churn signals combined with volatility), with full hotspot scoring planned when complexity metrics are added.

## Process vs Code vs Network Metrics

Empirical surveys (Rebro 2023, Zhang 2025) confirm that **process metrics** (churn, change frequency, author patterns) are the strongest standalone predictors, but combining all three categories yields the best results:

| Category | tea-rags coverage | Key metrics |
|----------|-------------------|-------------|
| Process (churn) | Full | commitCount, relativeChurn, changeDensity, churnVolatility, recencyWeightedFreq, bugFixRate |
| Author (process) | Full | dominantAuthor, dominantAuthorPct, contributorCount, knowledgeSilo |
| Network (dependencies) | Partial (fan-out only) | imports[] |
| Complexity | Planned | cyclomatic, cognitive (via tree-sitter AST) |

## Metric Definitions

tea-rags computes churn metrics at **two levels**:

1. **File-level** — from `git log` via isomorphic-git. All chunks of a file share the same file-level metrics.
2. **Chunk-level** — by diffing commit trees and mapping line-level hunks to chunk boundaries. Each chunk gets its own churn overlay reflecting only the commits that touched its specific line range.

### File-Level Metrics

#### commitCount

**Formula:** Count of distinct commits touching this file.

**Use cases:**

- High churn detection: `commitCount >= 10` indicates frequently modified code.
- Stability assessment: `commitCount == 1` means code hasn't changed since creation.

#### relativeChurn

**Formula:** `(linesAdded + linesDeleted) / currentLines`

**Interpretation:**

| Range | Meaning |
|-------|---------|
| `< 0.5` | Stable code, few modifications relative to size |
| `1.0 - 3.0` | Moderate churn, actively developed |
| `> 5.0` | High churn, code has been rewritten multiple times |

**Research basis:** [Nagappan & Ball (2005)](https://doi.org/10.1145/1062455.1062514) found relative code churn (normalized by file size) is a better defect predictor than absolute churn.

#### recencyWeightedFreq

**Formula:** `sum( exp(-0.1 * daysAgo) )` for each commit

Exponential decay weighting — recent commits contribute more than old ones. A commit from today contributes ~1.0, from 7 days ago ~0.5, from 23 days ago ~0.1.

**Use cases:**

- "What code is actively being worked on?" — sort by `recencyWeightedFreq DESC`.
- Sprint/release analysis — high values indicate active development.
- Incident response — find recently changed code near the bug.

#### changeDensity

**Formula:** `commitCount / months` (where months = span from first to last commit)

**Interpretation:**

| Range | Meaning |
|-------|---------|
| `< 1` | Less than one change per month (stable) |
| `1 - 5` | Regular maintenance |
| `> 10` | Hotspot, frequent changes |

#### churnVolatility

**Formula:** `stddev(days between consecutive commits)`

Measures the regularity of changes:

- **Low volatility** (`< 5`): Regular, predictable changes (e.g., CI-driven updates).
- **High volatility** (`> 30`): Irregular bursts of activity, potentially problematic.

#### bugFixRate

**Formula:** percentage of commits matching `/\b(fix|bug|hotfix|patch|resolve[sd]?|defect)\b/i` (0-100)

Percentage of commits to this file that are bug fixes. Higher values indicate code that has needed more corrections.

**Use cases:**

- Tech debt assessment: files with `bugFixRate > 40` may need redesign.
- Quality metrics: track bugFixRate trends across releases.
- Security audit: high bugFixRate in auth/crypto code warrants review.

#### contributorCount

**Formula:** `authors.length` (explicit field for filtering)

Number of unique contributors to this file. Redundant with `authors[]` but provided as a numeric field for Qdrant range filters.

**Use cases:**

- Knowledge silo detection: `contributorCount == 1` (bus factor risk).
- Collaboration metrics: high contributorCount indicates shared ownership.

### Chunk-Level Metrics

Chunk-level metrics provide per-function/per-block granularity within a file. They are computed by analyzing which line ranges each commit actually changed, then mapping those changes to chunk boundaries.

#### chunkCommitCount

**Formula:** Count of commits whose diff hunks overlap this chunk's line range.

Unlike file-level `commitCount` (which counts all commits to the file), this counts only commits that modified lines within this specific chunk. Enables finding "the churny function" inside a large stable file.

#### chunkChurnRatio

**Formula:** `chunkCommitCount / fileCommitCount` (0-1)

Ratio of chunk-specific commits to total file commits. Values close to 1.0 mean this chunk is responsible for most of the file's churn; low values mean the file is churny but this chunk is stable.

#### chunkContributorCount

**Formula:** Count of unique authors whose commits touched this chunk's lines.

#### chunkBugFixRate

**Formula:** percentage of chunk-touching commits matching bug-fix patterns (0-100)

Same pattern as file-level `bugFixRate`, but scoped to commits that actually modified this chunk.

#### chunkLastModifiedAt / chunkAgeDays

**Formula:** Timestamp and days-since of the most recent commit that touched this chunk.

A file may have been modified yesterday (file-level `ageDays=1`), but a specific chunk within it may not have changed in months (`chunkAgeDays=90`).

### Additional File-Level Fields

| Field | Type | Description |
|-------|------|-------------|
| `dominantAuthor` | string | Author with most commits to this file |
| `dominantAuthorEmail` | string | Email of dominant author |
| `dominantAuthorPct` | number | Percentage of commits by dominant author (0-100) |
| `authors` | string[] | All unique authors |
| `contributorCount` | number | Number of unique authors (= authors.length) |
| `lastModifiedAt` | number | Unix timestamp of most recent commit |
| `firstCreatedAt` | number | Unix timestamp of first commit |
| `lastCommitHash` | string | SHA of most recent commit |
| `ageDays` | number | Days since last modification |
| `linesAdded` | number | Total lines added across all commits |
| `linesDeleted` | number | Total lines deleted across all commits |
| `bugFixRate` | number | Percentage of bug-fix commits (0-100) |
| `taskIds` | string[] | Extracted ticket IDs (JIRA, GitHub, etc.) |

## References

1. Nagappan, N. & Ball, T. (2005). ["Use of Relative Code Churn Measures to Predict System Defect Density."](https://doi.org/10.1145/1062455.1062514) ICSE 2005, pp. 284-292.
2. Nagappan, N. & Ball, T. (2007). ["Using Software Dependencies and Churn Metrics to Predict Field Failures."](https://doi.org/10.1109/ESEM.2007.27) ISSRE 2007.
3. Munson, J.C. & Elbaum, S.G. (1998). ["Code Churn: A Measure for Estimating the Impact of Code Change."](https://doi.org/10.1109/ICSM.1998.738486)
4. Hassan, A.E. (2009). ["Predicting Faults Using the Complexity of Code Changes."](https://doi.org/10.1109/ICSE.2009.5070510) ICSE 2009.
5. Graves, T.L. et al. (2000). ["Predicting Fault Incidence Using Software Change History."](https://doi.org/10.1109/32.859533) IEEE TSE.
6. Tornhill, A. (2024). ["Your Code as a Crime Scene, Second Edition."](https://pragprog.com/titles/atcrime2/your-code-as-a-crime-scene-second-edition/) Pragmatic Bookshelf.
7. Shin, Y. et al. (2010). ["Can Complexity, Coupling, and Cohesion Metrics Be Used as Early Indicators of Vulnerabilities?"](https://doi.org/10.1145/1774088.1774504) ACM SAC.
8. Rebro, D.A. et al. (2023). ["Source Code Metrics for Software Defects Prediction."](https://arxiv.org/abs/2301.08022) arXiv:2301.08022.
9. Martin, R.C. (2002). "Agile Software Development: Principles, Patterns, and Practices." Prentice Hall.
