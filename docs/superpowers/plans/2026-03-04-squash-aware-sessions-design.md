# Squash-Aware Session Normalization for Git Signals

**Date:** 2026-03-04 **Ticket:** tea-rags-mcp-2o2 **Status:** Approved

## Problem

Agent-style development produces burst commits (10-15 per feature) that inflate
`commitCount` and cascade to churn, stability, bugFixRate, changeDensity,
recencyWeightedFreq, and churnVolatility signals.

## Solution

Config-driven transparent substitution: when
`TRAJECTORY_GIT_SQUASH_AWARE_SESSIONS=true`, group commits into sessions by
`(author, time gap)` and use session count in place of commit count. All
downstream consumers (derived signals, presets, overlay masks) require zero
changes.

## Config

| Env var                                | Default | Description                  |
| -------------------------------------- | ------- | ---------------------------- |
| `TRAJECTORY_GIT_SQUASH_AWARE_SESSIONS` | `false` | Enable session grouping      |
| `TRAJECTORY_GIT_SESSION_GAP_MINUTES`   | `30`    | Silence gap between sessions |

## Session Grouping Algorithm

```
Input: CommitInfo[] (unsorted)
Output: Session[]

1. Sort commits by (author ASC, timestamp ASC)
2. For each author's commit sequence:
   - If gap >= SESSION_GAP_MINUTES from previous commit → new session
   - Session inherits: author, timestamps (first/last), isFix flag
3. Session.isFix = true if ANY commit in session message starts with "fix:"
4. Merge commits (parents > 1) are excluded from session grouping
```

## Affected Metrics (squash-aware when enabled)

| Metric                | Current                            | With sessions                |
| --------------------- | ---------------------------------- | ---------------------------- |
| `commitCount`         | `commits.length`                   | `sessions.length`            |
| `bugFixRate`          | `fixCommits / commits`             | `fixSessions / sessions`     |
| `changeDensity`       | `commits / months`                 | `sessions / months`          |
| `recencyWeightedFreq` | `Σ exp(-0.1 × daysAgo)` per commit | per session (last commit ts) |
| `churnVolatility`     | `stddev(commit gaps)`              | `stddev(session gaps)`       |

## Unaffected Metrics

- `linesAdded/Deleted` — real line counts, not count-dependent
- `relativeChurn` — based on lines, not commits
- `ageDays` — real timestamps
- `authors/dominantAuthor/contributorCount` — unique author sets

## Chunk-Level Sessions

Filter sessions by "at least one commit in session touched this chunk's line
range". `chunk.commitCount = sessions touching chunk`.

## Corner Cases

1. **Single commit** → 1 session, no difference
2. **Gap exactly at threshold** → `>=` starts new session
3. **Merge commits** → excluded (don't carry authoring intent)
4. **Zero commits** → 0 sessions, Laplace smoothing handles division
5. **Cross-author simultaneous work** → separate sessions per author

## Blast Radius

- `src/core/trajectory/git/infra/metrics.ts` — `groupIntoSessions()`, modify
  `computeFileSignals()` and `computeChunkSignals()`
- `src/bootstrap/config.ts` — two new env vars
- **Zero changes** to: derived signals, presets, overlay masks, reranker, search
  module
- Requires reindex after enabling
