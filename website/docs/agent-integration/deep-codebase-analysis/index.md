---
title: "Deep Codebase Analysis"
sidebar_position: 1
---

import AiQuery from '@site/src/components/AiQuery';

# Deep Codebase Analysis

TeaRAGs exposes git-derived signals at **two granularity levels** — file and chunk (function). Understanding when to use which level is the key to meaningful analysis. This page covers **metric interpretation, threshold tables, and decision frameworks** — what the numbers mean and how to read them.

For which tools and presets to use for each task, see [Search Strategies](/agent-integration/search-strategies). For how agents should use these signals during code generation, see [Agentic Data-Driven Engineering](/agent-integration/agentic-data-driven-engineering).

## File-Level vs Chunk-Level Metrics: When to Use Each

Every indexed chunk carries both file-level and chunk-level git metrics. They measure different things and answer different questions.

### File-level metrics

File-level metrics (`commitCount`, `relativeChurn`, `bugFixRate`, `ageDays`, `dominantAuthor`) describe the **file as a whole**. All chunks within the same file share identical file-level values.

**Use file-level metrics when:**

- **Scanning for general hotspots** — "which files change most?" is a coarse but fast signal. A file with `commitCount >= 20` is worth investigating further.
- **Ownership analysis** — `dominantAuthor` and `contributorCount` are inherently file-scoped. Git tracks commits per file, not per function.
- **Relative churn assessment** — `relativeChurn` (lines changed / file size) is the strongest single defect predictor according to [Nagappan & Ball (2005)](/knowledge-base/code-churn-research#why-relative-churn-beats-absolute-churn). It normalizes for file size, so a 50-line file with 100 lines changed (`relativeChurn = 2.0`) ranks higher than a 2000-line file with the same changes (`relativeChurn = 0.05`).
- **Task traceability** — `taskIds` are extracted from commit messages at file level.
- **Legacy code discovery** — `ageDays` at file level tells you when the file was last touched, regardless of which function inside it changed.

**Limitations:** A 500-line file with 30 commits may have one function that absorbed 28 of them. File-level `commitCount = 30` makes the whole file look churny, but only one function is the problem. You need chunk-level metrics to see this.

### Chunk-level metrics

Chunk-level metrics (`chunkCommitCount`, `chunkChurnRatio`, `chunkBugFixRate`, `chunkAgeDays`) describe a **specific function, method, or code block** within a file. They are computed by mapping diff hunks to chunk line ranges.

**Use chunk-level metrics when:**

- **Pinpointing the exact problem** — `chunkCommitCount` tells you which function inside a churny file is actually causing the churn. A file with `commitCount = 25` might have one function with `chunkCommitCount = 22` and another with `chunkCommitCount = 1`.
- **Refactoring prioritization** — `chunkChurnRatio` (chunk commits / file commits) close to 1.0 means this one function is responsible for nearly all of the file's churn. That function is the refactoring target, not the file.
- **Function-level bug density** — `chunkBugFixRate` at 60% means most commits to this specific function were bug fixes. The file-level `bugFixRate` might be only 30% because other functions dilute the signal.
- **Stable code inside unstable files** — `chunkAgeDays = 180` inside a file with `ageDays = 2` means this function hasn't been touched in 6 months, even though the file was modified yesterday. This function is stable and reliable as a template.

**Limitations:** Chunk-level metrics require git enrichment (`TRAJECTORY_GIT_ENABLED=true`, on by default) and only cover commits within the `TRAJECTORY_GIT_CHUNK_MAX_AGE_MONTHS` window (default: 6 months). Older commits fall back to file-level data.

### Decision guide

| Question | Use | Key metric |
|----------|-----|------------|
| Which files change most? | File | `commitCount`, `relativeChurn` |
| Which *function* changes most? | Chunk | `chunkCommitCount`, `chunkChurnRatio` |
| Is this file a defect predictor? | File | `relativeChurn` ([Nagappan](/knowledge-base/code-churn-research#why-relative-churn-beats-absolute-churn): 89% accuracy) |
| Is this *function* buggy? | Chunk | `chunkBugFixRate` |
| Who owns this area? | File | `dominantAuthor`, `dominantAuthorPct` |
| Who last touched this function? | Chunk | `chunkAgeDays`, `chunkContributorCount` |
| Is the churn healthy or pathological? | Both | Compare `commitCount` vs `bugFixRate` — high commits + low bugfix = healthy iteration; high commits + high bugfix = pathological |
| What should I refactor first? | Chunk | `chunkChurnRatio` + `chunkBugFixRate` + chunk size |
