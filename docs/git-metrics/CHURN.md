# Code Churn Metrics

## Overview

Code churn metrics quantify how frequently and intensively code changes over time. Research shows that churn is one of the strongest predictors of software defects (Nagappan & Ball 2005, Munson & Elbaum 1998).

tea-rags-mcp computes churn metrics at **two levels**:

1. **File-level** — from `git log` via isomorphic-git (0 process spawns). All chunks of a file share the same file-level metrics.
2. **Chunk-level** — by diffing commit trees and mapping line-level hunks to chunk boundaries. Each chunk gets its own churn overlay reflecting only the commits that touched its specific line range.

All metrics are stored in Qdrant as part of the `git.*` payload and are available for filtering and reranking.

## Architecture

```
Phase 1: File-level enrichment
  git log (isomorphic-git, reads .git directly)
    → per-file CommitInfo[] + linesAdded/linesDeleted
      → computeFileMetadata()
        → GitFileMetadata (stored on all chunks of the file)

Phase 2: Chunk-level churn overlay
  git log (last N commits, isomorphic-git)
    → for each commit: diffTrees(parent, commit) → changed files
      → filter to files with >1 chunk in index
        → readBlob(parent) + readBlob(commit) → structuredPatch (jsdiff)
          → hunks with line numbers → overlaps(hunk, chunk)
            → per-chunk accumulators → ChunkChurnOverlay
              → batchSetPayload with dot-notation merge (git.chunkCommitCount, etc.)
```

- **No git blame**: All metrics derive from commit history, not per-line attribution
- **No process spawns for commit data**: isomorphic-git reads `.git/objects/pack/` directly
- **Single CLI call**: Only `git log --all --numstat` for line-level stats (1 spawn total)
- **Background**: Both phases run asynchronously after indexing returns
- **HEAD-based caching**: Results are cached and invalidated when HEAD changes

## File-Level Metrics

### 1. commitCount

**Formula:** Count of distinct commits touching this file.

**Use cases:**
- High churn detection: `commitCount >= 10` indicates frequently modified code
- Stability assessment: `commitCount == 1` means code hasn't changed since creation

### 2. relativeChurn

**Formula:** `(linesAdded + linesDeleted) / currentLines`

**Interpretation:**
- `relativeChurn < 0.5` — Stable code, few modifications relative to size
- `relativeChurn 1.0-3.0` — Moderate churn, actively developed
- `relativeChurn > 5.0` — High churn, code has been rewritten multiple times

**Research basis:** Nagappan & Ball (2005) found relative code churn (normalized by file size) is a better defect predictor than absolute churn.

### 3. recencyWeightedFreq

**Formula:** `Σ exp(-0.1 × daysAgo)` for each commit

Exponential decay weighting — recent commits contribute more than old ones. A commit from today contributes ~1.0, from 7 days ago ~0.5, from 23 days ago ~0.1.

**Use cases:**
- "What code is actively being worked on?" — sort by `recencyWeightedFreq DESC`
- Sprint/release analysis — high values indicate active development
- Incident response — find recently changed code near the bug

### 4. changeDensity

**Formula:** `commitCount / months` (where months = span from first to last commit)

**Interpretation:**
- `changeDensity < 1` — Less than one change per month (stable)
- `changeDensity 1-5` — Regular maintenance
- `changeDensity > 10` — Hotspot, frequent changes

### 5. churnVolatility

**Formula:** `stddev(days between consecutive commits)`

Measures the regularity of changes:
- **Low volatility** (< 5): Regular, predictable changes (e.g., CI-driven updates)
- **High volatility** (> 30): Irregular bursts of activity, potentially problematic

### 6. bugFixRate

**Formula:** `% of commits matching /fix|bug|hotfix|patch|resolved?|defect/i` (0-100)

Percentage of commits to this file that are bug fixes. Higher values indicate code that has needed more corrections.

**Use cases:**
- Tech debt assessment: files with `bugFixRate > 40` may need redesign
- Quality metrics: track bugFixRate trends across releases
- Security audit: high bugFixRate in auth/crypto code warrants review

### 7. contributorCount

**Formula:** `authors.length` (explicit field for filtering)

Number of unique contributors to this file. Redundant with `authors[]` but provided as a numeric field for Qdrant range filters.

**Use cases:**
- Knowledge silo detection: `contributorCount == 1` (bus factor risk)
- Collaboration metrics: high contributorCount indicates shared ownership

## Chunk-Level Metrics

Chunk-level metrics provide per-function/per-block granularity within a file. They are computed by analyzing which line ranges each commit actually changed, then mapping those changes to chunk boundaries.

### chunkCommitCount

**Formula:** Count of commits whose diff hunks overlap this chunk's line range.

Unlike file-level `commitCount` (which counts all commits to the file), this counts only commits that modified lines within this specific chunk. Enables finding "the churny function" inside a large stable file.

### chunkChurnRatio

**Formula:** `chunkCommitCount / fileCommitCount` (0-1)

Ratio of chunk-specific commits to total file commits. Values close to 1.0 mean this chunk is responsible for most of the file's churn; low values mean the file is churny but this chunk is stable.

### chunkContributorCount

**Formula:** Count of unique authors whose commits touched this chunk's lines.

### chunkBugFixRate

**Formula:** `% of chunk-touching commits matching bug-fix patterns` (0-100)

Same pattern as file-level `bugFixRate`, but scoped to commits that actually modified this chunk.

### chunkLastModifiedAt / chunkAgeDays

**Formula:** Timestamp and days-since of the most recent commit that touched this chunk.

A file may have been modified yesterday (file-level `ageDays=1`), but a specific chunk within it may not have changed in months (`chunkAgeDays=90`).

## Additional File-Level Fields

| Field | Type | Description |
|-------|------|-------------|
| `dominantAuthor` | string | Author with most commits to this file |
| `dominantAuthorEmail` | string | Email of dominant author |
| `dominantAuthorPct` | number | % of commits by dominant author (0-100) |
| `authors` | string[] | All unique authors |
| `contributorCount` | number | Number of unique authors (= authors.length) |
| `lastModifiedAt` | number | Unix timestamp of most recent commit |
| `firstCreatedAt` | number | Unix timestamp of first commit |
| `lastCommitHash` | string | SHA of most recent commit |
| `ageDays` | number | Days since last modification |
| `linesAdded` | number | Total lines added across all commits |
| `linesDeleted` | number | Total lines deleted across all commits |
| `bugFixRate` | number | % of bug-fix commits (0-100) |
| `taskIds` | string[] | Extracted ticket IDs (JIRA, GitHub, etc.) |

## Filtering Examples

```json
// Find high-churn code (file-level)
{ "key": "git.commitCount", "range": { "gte": 10 } }

// Find code with high relative churn
{ "key": "git.relativeChurn", "range": { "gte": 2.0 } }

// Find single-owner code (knowledge silos)
{ "key": "git.dominantAuthorPct", "range": { "gte": 90 } }

// Find recently active code
{ "key": "git.ageDays", "range": { "lte": 7 } }

// Find buggy code
{ "key": "git.bugFixRate", "range": { "gte": 30 } }

// Find hot chunks (chunk-level churn)
{ "key": "git.chunkCommitCount", "range": { "gte": 5 } }

// Find chunks that are mostly bug fixes
{ "key": "git.chunkBugFixRate", "range": { "gte": 50 } }

// Find stable chunks inside churny files
{
  "must": [
    { "key": "git.commitCount", "range": { "gte": 20 } },
    { "key": "git.chunkCommitCount", "range": { "lte": 3 } }
  ]
}
```

## Reranking Presets

All presets automatically prefer chunk-level data when available (e.g., `chunkCommitCount` over `commitCount` for churn signals).

| Preset | Signals | Use case |
|--------|---------|----------|
| `hotspots` | chunkChurn + recency + bugFix + volatility | Bug-prone areas at function granularity |
| `techDebt` | age + churn + bugFix + volatility | Legacy assessment with fix-rate indicator |
| `codeReview` | recency + density + chunkChurn | Recent changes with activity intensity |
| `stable` | low churn | Reliable implementations |
| `ownership` | dominantAuthorPct | Knowledge transfer (uses precise % now) |
| `refactoring` | chunkChurn + chunkSize + volatility + bugFix + age | Refactor candidates at chunk level |
| `securityAudit` | age + ownership + bugFix | Old critical code with fix history |
| `impactAnalysis` | imports | Dependency analysis |
| `onboarding` | documentation + stability | Entry points for new team members |

### Scoring Weights Reference

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
| `bugFix` | bugFixRate (0-100 normalized) | git |
| `volatility` | churnVolatility (stddev of commit gaps) | git |
| `density` | changeDensity (commits/month) | git |
| `chunkChurn` | chunkCommitCount | git chunk-level |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CODE_ENABLE_GIT_METADATA` | `"false"` | Enable git enrichment during indexing |
| `GIT_CHUNK_ENABLED` | `"true"` | Enable chunk-level churn analysis |
| `GIT_CHUNK_DEPTH` | `200` | Max commits to analyze for chunk-level churn |
| `GIT_CHUNK_CONCURRENCY` | `10` | Parallel commit processing for chunk churn |
| `GIT_CHUNK_MAX_FILE_LINES` | `10000` | Skip files larger than this for chunk analysis |

## Performance

For a typical project (~2000 files, ~200 commits):

**File-level enrichment:** Reads entire git history in a single isomorphic-git pass. Typically 0.5-2s.

**Chunk-level churn:** Walks last N commits, diffs trees, reads blobs, computes line-level patches:
- 200 commits x ~5 changed files/commit x 60% in index x filter (>1 chunk) = ~400 file diffs
- Each: 2 blob reads (pack cache ~1ms) + 1 structuredPatch (~0.5ms) = ~2.5ms
- With 10 concurrent workers: **~100ms**
- Total overhead: **< 1s** on top of file-level enrichment

Both phases are cached by HEAD SHA and run in background (non-blocking to indexing).

## Skip Conditions

Chunk-level analysis is automatically skipped for:
- **Single-chunk files** — chunk = file, no granularity benefit
- **Files with 1 commit** — all chunks would get identical data
- **Files > GIT_CHUNK_MAX_FILE_LINES** — performance guard
- **Binary files** — blob read fails gracefully
- **Root commits** — no parent to diff against

## References

1. Nagappan, N. & Ball, T. (2005). "Use of Relative Code Churn Measures to Predict System Defect Density." ICSE 2005.
2. Munson, J.C. & Elbaum, S.G. (1998). "Code Churn: A Measure for Estimating the Impact of Code Change."
3. Hassan, A.E. (2009). "Predicting Faults Using the Complexity of Code Changes." ICSE 2009.
4. Graves, T.L. et al. (2000). "Predicting Fault Incidence Using Software Change History." IEEE TSE.
