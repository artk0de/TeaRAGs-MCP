---
title: Git Enrichments
sidebar_position: 5
---

import AiQuery from '@site/src/components/AiQuery';

# Git Enrichments

tea-rags enriches every indexed code chunk with **20 git-derived quality signals** — churn, stability, authorship, bug-fix rates, code age — at **function-level granularity**. These signals power filtering and reranking, so your AI agent finds not just relevant code, but code that is stable, well-owned, and battle-tested.

:::tip
Git enrichment runs concurrently with embedding and does not increase indexing time.
:::

## Enabling Git Enrichment

Set the environment variable when configuring your MCP server:

```bash
claude mcp add tea-rags -s user -- node /path/to/tea-rags-mcp/build/index.js \
  -e CODE_ENABLE_GIT_METADATA=true
```

## What You Get

tea-rags computes metrics at **two levels**:

1. **File-level** — shared by all chunks of a file (commitCount, relativeChurn, bugFixRate, authors, etc.)
2. **Chunk-level** — per-function granularity (chunkCommitCount, chunkChurnRatio, chunkBugFixRate, etc.)

For detailed metric definitions, formulas, and research context, see [Code Churn: Theory & Research](/knowledge-base/code-churn-research).

### Metrics at a Glance

| Metric | Level | What it tells you |
|--------|-------|-------------------|
| `commitCount` | File | How often this file changes |
| `relativeChurn` | File | Churn normalized by file size (stronger defect signal) |
| `recencyWeightedFreq` | File | Recent activity burst (exponential decay) |
| `changeDensity` | File | Commits per month |
| `churnVolatility` | File | Regularity of changes (stddev of commit gaps) |
| `bugFixRate` | File | Percentage of bug-fix commits ([detection details](#bug-fix-detection)) |
| `contributorCount` | File | Number of unique authors |
| `dominantAuthor` | File | Author with most commits |
| `dominantAuthorPct` | File | Ownership concentration (0-100) |
| `ageDays` | File | Days since last modification |
| `taskIds` | File | Extracted ticket IDs (JIRA, GitHub, etc.) |
| `chunkCommitCount` | Chunk | Commits touching this specific function/block |
| `chunkChurnRatio` | Chunk | This chunk's share of file churn (0-1) |
| `chunkContributorCount` | Chunk | Authors who touched this chunk |
| `chunkBugFixRate` | Chunk | Bug-fix rate for this chunk specifically |
| `chunkAgeDays` | Chunk | Days since this chunk was last modified |
| `chunkTaskIds` | Chunk | Ticket IDs from commits touching this chunk |

### Bug-Fix Commit Detection {#bug-fix-detection}

`bugFixRate` and `chunkBugFixRate` rely on heuristic classification of commits as bug fixes. The detection works as follows:

**Pattern:** Each commit message is tested against the regex:

```text
/\b(fix|bug|hotfix|patch|resolve[sd]?|defect)\b/i
```

This matches whole words only (word boundaries `\b` prevent false positives like "prefix" or "bugle"). The match is case-insensitive and checks the **full commit body** — not just the subject line.

**Merge commit filtering:** Commits whose subject line starts with `Merge` (e.g., `Merge branch 'fix/auth'`, `Merge pull request #42`) are **excluded** from bug-fix detection. The rationale: a merge commit referencing a fix branch is not itself a fix — the actual fix commit within the branch is already counted separately. Without this filter, every merged fix branch would be double-counted.

**What matches:**

| Commit message | Detected? | Why |
|----------------|-----------|-----|
| `fix: resolve crash on login` | Yes | "fix" in subject |
| `hotfix: emergency patch for payments` | Yes | "hotfix" in subject |
| `Resolved issue with timeout` | Yes | "Resolved" matches `resolve[sd]?` |
| `Bug in date parsing` | Yes | "Bug" matches |
| `chore: update deps` | No | No bug-fix keywords |
| `Merge branch 'fix/auth'` | No | Merge commit — skipped |
| `Merge pull request #42 from user/fix-auth` | No | Merge commit — skipped |
| `chore: update auth\nfix: also resolve login bug` | Yes | "fix" found on 2nd line (full body is checked) |

**Formula:**

```text
bugFixRate = round((bugFixCommits / totalCommits) * 100)
```

Where `bugFixCommits` is the count of non-merge commits matching the pattern. The result is an integer percentage (0-100).

**Chunk-level:** `chunkBugFixRate` uses the same detection logic, but only counts commits whose diff hunks overlap the chunk's line range.

:::info
The pattern is intentionally broad — it catches conventional commits (`fix: ...`), free-form messages (`fixed the bug`), and ticket-driven messages (`resolve TD-123 defect`). False positive rate is low due to word boundary matching.
:::

## Use Cases

<AiQuery>Show me files with high churn rate</AiQuery>
<AiQuery>Find code with a single dominant author</AiQuery>
<AiQuery>What code changed in the last week?</AiQuery>
<AiQuery>Find hot functions that change frequently</AiQuery>
<AiQuery>Show me legacy code with high bug-fix rates</AiQuery>

For detailed scenarios — hotspot detection, knowledge silo analysis, tech debt assessment, incident-driven search, security audit, and more — see [Git Enrichment Use Cases](/usage/use-cases#git-enrichment-use-cases).

## Reranking Presets

All presets automatically prefer chunk-level data when available (e.g., `chunkCommitCount` over `commitCount` for churn signals).

| Preset | Signals | Use case |
|--------|---------|----------|
| `hotspots` | chunkChurn + chunkRelativeChurn + burstActivity + bugFix + volatility | Bug-prone areas at function granularity |
| `techDebt` | age + churn + bugFix + volatility | Legacy assessment with fix-rate indicator |
| `codeReview` | recency + burstActivity + density + chunkChurn | Recent changes with activity intensity |
| `stable` | low churn | Reliable implementations |
| `ownership` | ownership + knowledgeSilo | Knowledge transfer, bus factor analysis |
| `refactoring` | chunkChurn + relativeChurnNorm + chunkSize + volatility + bugFix + age | Refactor candidates at chunk level |
| `securityAudit` | age + ownership + bugFix + pathRisk + volatility | Old critical code in sensitive paths |
| `onboarding` | documentation + stability | Entry points for new team members |

## Scoring Weights Reference

Available weight keys for custom reranking:

| Key | Signal | Source |
|-----|--------|--------|
| `similarity` | Embedding similarity score | Vector search |
| `recency` | Inverse of ageDays (prefers chunk-level) | git |
| `stability` | Inverse of commitCount (prefers chunk-level) | git |
| `churn` | Direct commitCount (prefers chunk-level) | git |
| `age` | Direct ageDays (prefers chunk-level) | git |
| `ownership` | Author concentration via dominantAuthorPct | git |
| `chunkSize` | Lines of code in chunk | chunk metadata |
| `documentation` | Is documentation file | chunk metadata |
| `imports` | Import/dependency count | file metadata |
| `bugFix` | bugFixRate (prefers chunk-level) | git |
| `volatility` | churnVolatility (stddev of commit gaps) | git |
| `density` | changeDensity (commits/month) | git |
| `chunkChurn` | chunkCommitCount | git chunk-level |
| `relativeChurnNorm` | relativeChurn normalized (churn relative to file size) | git |
| `burstActivity` | recencyWeightedFreq — recent burst of changes | git |
| `pathRisk` | Security-sensitive path pattern match (0 or 1) | file metadata |
| `knowledgeSilo` | Single-contributor flag (1 / 0.5 / 0) | git |
| `chunkRelativeChurn` | chunkChurnRatio — chunk's share of file churn | git chunk-level |

## Environment Variables

<details>
<summary>Git enrichment configuration</summary>

| Variable | Default | Description |
|----------|---------|-------------|
| `CODE_ENABLE_GIT_METADATA` | `"false"` | Enable git enrichment during indexing |
| `GIT_LOG_MAX_AGE_MONTHS` | `12` | Time window for file-level git analysis (months). `0` = no age limit (safety depth still applies). |
| `GIT_LOG_TIMEOUT_MS` | `30000` | Timeout for isomorphic-git; falls back to native CLI on expiry |
| `GIT_LOG_SAFETY_DEPTH` | `10000` | Max commits for isomorphic-git `depth` and CLI `--max-count` |
| `GIT_CHUNK_ENABLED` | `"true"` | Enable chunk-level churn analysis |
| `GIT_CHUNK_MAX_AGE_MONTHS` | `6` | Time window for chunk-level churn analysis (months). `0` = no age limit. |
| `GIT_CHUNK_CONCURRENCY` | `10` | Parallel commit processing for chunk churn |
| `GIT_CHUNK_MAX_FILE_LINES` | `10000` | Skip files larger than this for chunk analysis |

</details>

## Next Steps

- [Filters](/usage/filters) — filter syntax, git churn filters, filterable fields reference
- [Code Churn: Theory & Research](/knowledge-base/code-churn-research) — metric formulas, research basis, and academic references
- [Git Enrichment Pipeline](/architecture/git-enrichment-pipeline) — architecture, design decisions, and performance characteristics
- [Search Strategies](/agent-integration/search-strategies) — how agents use reranking presets for different tasks
- [Configuration Variables](/config/environment-variables) — full list of all configuration options
