---
title: Git Enrichments
sidebar_position: 5
---

import AiQuery from '@site/src/components/AiQuery';

# Git Enrichments

tea-rags enriches every indexed code chunk with **20 git-derived quality
signals** — churn, stability, authorship, bug-fix rates, code age — at
**function-level granularity**. These signals power filtering and reranking, so
your AI agent finds not just relevant code, but code that is stable, well-owned,
and battle-tested.

:::tip Git enrichment runs concurrently with embedding and does not increase
indexing time. :::

## Enabling Git Enrichment

Set the environment variable when configuring your MCP server:

```bash
claude mcp add tea-rags -s user -- node /path/to/tea-rags/build/index.js \
  -e CODE_ENABLE_GIT_METADATA=true
```

## What You Get

tea-rags computes metrics at **two levels**:

1. **File-level** — shared by all chunks of a file (commitCount, relativeChurn,
   bugFixRate, authors, etc.)
2. **Chunk-level** — per-function granularity (chunkCommitCount,
   chunkChurnRatio, chunkBugFixRate, etc.)

For detailed metric definitions, formulas, and research context, see
[Code Churn: Theory & Research](/knowledge-base/code-churn-research).

### Metrics at a Glance

| Metric                  | Level | What it tells you                                                       |
| ----------------------- | ----- | ----------------------------------------------------------------------- |
| `commitCount`           | File  | How often this file changes                                             |
| `relativeChurn`         | File  | Churn normalized by file size (stronger defect signal)                  |
| `recencyWeightedFreq`   | File  | Recent activity burst (exponential decay)                               |
| `changeDensity`         | File  | Commits per month                                                       |
| `churnVolatility`       | File  | Regularity of changes (stddev of commit gaps)                           |
| `bugFixRate`            | File  | Percentage of bug-fix commits ([detection details](#bug-fix-detection)) |
| `contributorCount`      | File  | Number of unique authors                                                |
| `dominantAuthor`        | File  | Author with most commits                                                |
| `dominantAuthorPct`     | File  | Ownership concentration (0-100)                                         |
| `ageDays`               | File  | Days since last modification                                            |
| `taskIds`               | File  | Extracted ticket IDs (JIRA, GitHub, etc.)                               |
| `chunkCommitCount`      | Chunk | Commits touching this specific function/block                           |
| `chunkChurnRatio`       | Chunk | This chunk's share of file churn (0-1)                                  |
| `chunkContributorCount` | Chunk | Authors who touched this chunk                                          |
| `chunkBugFixRate`       | Chunk | Bug-fix rate for this chunk specifically                                |
| `chunkAgeDays`          | Chunk | Days since this chunk was last modified                                 |
| `chunkTaskIds`          | Chunk | Ticket IDs from commits touching this chunk                             |

### Bug-Fix Commit Detection {#bug-fix-detection}

`bugFixRate` and `chunkBugFixRate` rely on a multi-layered heuristic
classification of commits as bug fixes. The detection uses two independent
mechanisms that work together:

#### Layer 0: Merge Branch Resolution

Before analyzing individual commit messages, tea-rags identifies **gitflow fix
branches** by inspecting merge commits and traversing the parent graph.

When a merge commit matches one of these patterns:

```text
Merge branch 'fix/...'
Merge branch 'hotfix/...'
Merge branch 'bugfix/...'
Merge pull request #N from user/fix-...
Merge pull request #N from user/hotfix/...
Merge pull request #N from user/bugfix-...
```

All child commits reachable from the branch tip (second parent) are marked as
bug-fix commits via BFS traversal. This is critical for gitflow workflows where
child commits often don't contain "fix" in their message — e.g.,
`refactor: extract validation` inside a `fix/TD-123-crash` branch is correctly
classified as a bug fix.

#### Layer 1: Commit Message Classification

Each non-merge commit is tested through a **six-rule pipeline** applied in
order. The first matching rule wins.

**Rule 1 — Skip merge commits:**

```text
/^Merge\b/i → return false
```

Merge commits are not classified by message — their branches are already
resolved in Layer 0.

**Rule 2 — Exclude cosmetic/infrastructure fixes (false positive filter):**

Checked against the **full commit body**:

```text
/\bfix(?:e[sd])?\s+(?:typo|lint|linter|format|formatting|style|whitespace|
  indentation|imports?|tests?|specs?|flaky|rubocop|eslint|prettier|ci|
  pipeline|migration|review|code\s*review|conflicts?)\b/i

/\btext\s+fix(?:es)?\b/i
```

These are not real bug fixes — they are maintenance commits that happen to
contain the word "fix".

**Rule 3 — Conventional commit prefix** (subject line only):

```text
/^(?:hot)?fix(?:\([^)]+\))?!?:/i
```

Matches: `fix: ...`, `fix(auth): ...`, `hotfix: ...`, `fix(scope)!: ...`

**Rule 4 — Explicit tag** (subject line only):

```text
/^\[(?:Fix|Bug|Hotfix|Bugfix)\]/i
```

Matches: `[Fix] null pointer`, `[Bug] race condition`,
`[HOTFIX] production crash`

**Rule 5 — Ticket + Fix verb** (subject line only):

```text
/^\[?[A-Z]+-\d+\]?\s+(?:fix|fixed|fixes)\b/i
```

Matches: `[TD-123] Fix crash on login`, `PROJ-456 fixed timeout`,
`[ABC-789] fixes edge case`

**Rule 6 — GitHub/GitLab closing keywords** (full body):

```text
/\b(?:fix|fixe[sd]|resolve[sd]?|close[sd]?)\s+#\d+/i
```

Matches: `fixes #123`, `resolves #456`, `closes #789`, `Resolved #42`

**Default:** If no rule matches → **not a bug fix**.

#### Classification Examples

| Commit message                        | Detected? | Rule                                                 |
| ------------------------------------- | --------- | ---------------------------------------------------- |
| `fix: crash on null input`            | Yes       | Rule 3 — conventional prefix                         |
| `fix(auth): token expiration`         | Yes       | Rule 3 — conventional prefix                         |
| `hotfix: urgent payment bug`          | Yes       | Rule 3 — conventional prefix                         |
| `[Fix] null pointer in handler`       | Yes       | Rule 4 — explicit tag                                |
| `[Bug] race condition`                | Yes       | Rule 4 — explicit tag                                |
| `[TD-123] Fix crash on login`         | Yes       | Rule 5 — ticket + fix verb                           |
| (body contains `fixes #123`)          | Yes       | Rule 6 — closing keyword                             |
| `fix typo in readme`                  | No        | Rule 2 — cosmetic exclusion                          |
| `fix lint errors`                     | No        | Rule 2 — cosmetic exclusion                          |
| `fix tests`                           | No        | Rule 2 — cosmetic exclusion                          |
| `fix code review comments`            | No        | Rule 2 — cosmetic exclusion                          |
| `text fixes`                          | No        | Rule 2 — cosmetic exclusion                          |
| `chore: update deps`                  | No        | No rule matched                                      |
| `Merge branch 'fix/auth'`             | No        | Rule 1 — merge (but children are marked via Layer 0) |
| child commit inside `fix/auth` branch | Yes       | Layer 0 — merge branch resolution                    |

#### Formula

bugFixRate uses Laplace smoothing with Jeffreys prior (α = 0.5) to handle small
sample sizes:

```text
bugFixRate = round(((bugFixCommits + 0.5) / (totalCommits + 1.0)) * 100)
```

This prevents extreme values: a file with 0 fixes out of 1 commit gets 33% (not
0%), while a file with 1 fix out of 1 commit gets 75% (not 100%). The smoothing
effect diminishes as commit count grows.

**Chunk-level:** `chunkBugFixRate` uses the same detection logic, but only
counts commits whose diff hunks overlap the chunk's line range. An offset
tracker corrects for line drift caused by insertions/deletions above the chunk
in earlier commits.

:::info The detection is designed to minimize false positives. Cosmetic patterns
(fix typo, fix lint, fix tests, etc.) are explicitly excluded. Merge commits are
handled separately via branch resolution — their child commits inherit the fix
classification even when their individual messages don't mention "fix". :::

## Use Cases

<AiQuery>Show me files with high churn rate</AiQuery> <AiQuery>Find code with a
single dominant author</AiQuery> <AiQuery>What code changed in the last
week?</AiQuery> <AiQuery>Find hot functions that change frequently</AiQuery>
<AiQuery>Show me legacy code with high bug-fix rates</AiQuery>

For detailed scenarios — hotspot detection, knowledge silo analysis, tech debt
assessment, incident-driven search, security audit, and more — see
[Git Enrichment Use Cases](/usage/use-cases#git-enrichment-use-cases).

## Reranking Presets

All presets automatically prefer chunk-level data when available (e.g.,
`chunkCommitCount` over `commitCount` for churn signals).

| Preset          | Signals                                                                | Use case                                  |
| --------------- | ---------------------------------------------------------------------- | ----------------------------------------- |
| `hotspots`      | chunkChurn + chunkRelativeChurn + burstActivity + bugFix + volatility  | Bug-prone areas at function granularity   |
| `techDebt`      | age + churn + bugFix + volatility                                      | Legacy assessment with fix-rate indicator |
| `codeReview`    | recency + burstActivity + density + chunkChurn                         | Recent changes with activity intensity    |
| `stable`        | low churn                                                              | Reliable implementations                  |
| `ownership`     | ownership + knowledgeSilo                                              | Knowledge transfer, bus factor analysis   |
| `refactoring`   | chunkChurn + relativeChurnNorm + chunkSize + volatility + bugFix + age | Refactor candidates at chunk level        |
| `securityAudit` | age + ownership + bugFix + pathRisk + volatility                       | Old critical code in sensitive paths      |
| `onboarding`    | documentation + stability                                              | Entry points for new team members         |

## Scoring Weights Reference

Available weight keys for custom reranking:

| Key                  | Signal                                                 | Source          |
| -------------------- | ------------------------------------------------------ | --------------- |
| `similarity`         | Embedding similarity score                             | Vector search   |
| `recency`            | Inverse of ageDays (prefers chunk-level)               | git             |
| `stability`          | Inverse of commitCount (prefers chunk-level)           | git             |
| `churn`              | Direct commitCount (prefers chunk-level)               | git             |
| `age`                | Direct ageDays (prefers chunk-level)                   | git             |
| `ownership`          | Author concentration via dominantAuthorPct             | git             |
| `chunkSize`          | Lines of code in chunk                                 | chunk metadata  |
| `documentation`      | Is documentation file                                  | chunk metadata  |
| `imports`            | Import/dependency count                                | file metadata   |
| `bugFix`             | bugFixRate (prefers chunk-level)                       | git             |
| `volatility`         | churnVolatility (stddev of commit gaps)                | git             |
| `density`            | changeDensity (commits/month)                          | git             |
| `chunkChurn`         | chunkCommitCount                                       | git chunk-level |
| `relativeChurnNorm`  | relativeChurn normalized (churn relative to file size) | git             |
| `burstActivity`      | recencyWeightedFreq — recent burst of changes          | git             |
| `pathRisk`           | Security-sensitive path pattern match (0 or 1)         | file metadata   |
| `knowledgeSilo`      | Single-contributor flag (1 / 0.5 / 0)                  | git             |
| `chunkRelativeChurn` | chunkChurnRatio — chunk's share of file churn          | git chunk-level |

## Environment Variables

<details>
<summary>Git enrichment configuration</summary>

| Variable                   | Default   | Description                                                                                        |
| -------------------------- | --------- | -------------------------------------------------------------------------------------------------- |
| `CODE_ENABLE_GIT_METADATA` | `"true"`  | Enable git enrichment during indexing. Set to `"false"` to disable. Silently skipped on non-git directories. |
| `GIT_LOG_MAX_AGE_MONTHS`   | `12`      | Time window for file-level git analysis (months). `0` = no age limit (safety depth still applies). |
| `GIT_LOG_TIMEOUT_MS`       | `30000`   | Timeout for isomorphic-git; falls back to native CLI on expiry                                     |
| `GIT_LOG_SAFETY_DEPTH`     | `10000`   | Max commits for isomorphic-git `depth` and CLI `--max-count`                                       |
| `GIT_CHUNK_ENABLED`        | `"true"`  | Enable chunk-level churn analysis                                                                  |
| `GIT_CHUNK_MAX_AGE_MONTHS` | `6`       | Time window for chunk-level churn analysis (months). `0` = no age limit.                           |
| `GIT_CHUNK_CONCURRENCY`    | `10`      | Parallel commit processing for chunk churn                                                         |
| `GIT_CHUNK_MAX_FILE_LINES` | `10000`   | Skip files larger than this for chunk analysis                                                     |

</details>

## Next Steps

- [Filters](/usage/filters) — filter syntax, git churn filters, filterable
  fields reference
- [Code Churn: Theory & Research](/knowledge-base/code-churn-research) — metric
  formulas, research basis, and academic references
- [Git Enrichment Pipeline](/architecture/git-enrichment-pipeline) —
  architecture, design decisions, and performance characteristics
- [Search Strategies](/agent-integration/search-strategies) — how agents use
  reranking presets for different tasks
- [Configuration Variables](/config/environment-variables) — full list of all
  configuration options
