---
title: Git Enrichment Pipeline
sidebar_position: 5
---

# Git Enrichment Pipeline

import MermaidTeaRAGs from '@site/src/components/MermaidTeaRAGs';

tea-rags enriches every indexed code chunk with git-derived quality signals. The pipeline runs in two phases — file-level and chunk-level — both executing asynchronously in the background after indexing returns.

For metric definitions and research context, see [Code Churn: Theory & Research](/knowledge-base/code-churn-research). For practical usage (filtering, reranking), see [Git Enrichments](/usage/advanced/git-enrichments).

## Pipeline Overview

<MermaidTeaRAGs>
{`
flowchart TB
    subgraph phase1["Phase 1: File-Level Enrichment"]
        GitLog[🔀 git log<br/><small>isomorphic-git</small>]
        FileCommits[📋 Per-file CommitInfo[]<br/><small>+ linesAdded / linesDeleted</small>]
        ComputeMeta[⚙️ computeFileMetadata]
        GitFileMeta[📊 GitFileMetadata<br/><small>stored on all chunks of file</small>]

        GitLog --> FileCommits --> ComputeMeta --> GitFileMeta
    end

    subgraph phase2["Phase 2: Chunk-Level Churn Overlay"]
        GitLogN[🔀 git log<br/><small>last N commits</small>]
        DiffTrees[🔍 diffTrees<br/><small>parent vs commit</small>]
        FilterFiles[📁 Filter to files<br/><small>with >1 chunk in index</small>]
        ReadBlobs[📄 readBlob parent + commit<br/><small>structuredPatch via jsdiff</small>]
        MapHunks[🎯 Map hunks to chunks<br/><small>overlaps check</small>]
        ChurnOverlay[📊 ChunkChurnOverlay<br/><small>batchSetPayload</small>]

        GitLogN --> DiffTrees --> FilterFiles --> ReadBlobs --> MapHunks --> ChurnOverlay
    end

    Indexing[🍵 Indexing Complete] --> phase1
    Indexing --> phase2
    GitFileMeta --> Qdrant[(🗄️ Qdrant<br/><small>git.* payload</small>)]
    ChurnOverlay --> Qdrant
`}
</MermaidTeaRAGs>

## Key Design Decisions

- **No git blame** — all metrics derive from commit history, not per-line attribution.
- **No process spawns for commit data** — isomorphic-git reads `.git/objects/pack/` directly.
- **Single CLI call** — only `git log --all --numstat` for line-level stats (one spawn total).
- **Background execution** — both phases run asynchronously after indexing returns.
- **HEAD-based caching** — results are cached and invalidated when HEAD changes.

## Phase 1: File-Level Enrichment

Reads git history via isomorphic-git (bounded by `GIT_LOG_MAX_AGE_MONTHS`, default 12 months), with CLI fallback on timeout (`GIT_LOG_TIMEOUT_MS`).

```text
git log (isomorphic-git, reads .git directly)
  -> per-file CommitInfo[] + linesAdded/linesDeleted
    -> computeFileMetadata()
      -> GitFileMetadata (stored on all chunks of the file)
```

**Output:** `GitFileMetadata` containing commitCount, relativeChurn, recencyWeightedFreq, changeDensity, churnVolatility, bugFixRate, contributorCount, dominantAuthor, and other signals. Stored on **all chunks** of the file via the `git.*` payload namespace.

## Phase 2: Chunk-Level Churn Overlay

Walks recent commits, diffs trees, reads blobs, and computes line-level patches to determine which chunks were affected by each commit.

```text
git log (last N commits, isomorphic-git)
  -> for each commit: diffTrees(parent, commit) -> changed files
    -> filter to files with >1 chunk in index
      -> readBlob(parent) + readBlob(commit) -> structuredPatch (jsdiff)
        -> hunks with line numbers -> overlaps(hunk, chunk)
          -> per-chunk accumulators -> ChunkChurnOverlay
            -> batchSetPayload with dot-notation merge
               (git.chunkCommitCount, etc.)
```

**Output:** `ChunkChurnOverlay` containing chunkCommitCount, chunkChurnRatio, chunkContributorCount, chunkBugFixRate, chunkLastModifiedAt, chunkAgeDays. Merged into existing `git.*` payload using dot-notation to avoid overwriting file-level data.

## Performance

For a typical project (~2000 files, ~200 commits):

**File-level enrichment:** Typically 0.5-2s for small repos.

**Chunk-level churn:**

- 200 commits x ~5 changed files/commit x 60% in index x filter (>1 chunk) = ~400 file diffs
- Each: 2 blob reads (pack cache ~1ms) + 1 structuredPatch (~0.5ms) = ~2.5ms
- With 10 concurrent workers: **~100ms**
- Total overhead: **< 1s** on top of file-level enrichment

Both phases are cached by HEAD SHA and run in background (non-blocking to indexing).

## Skip Conditions

Chunk-level analysis is automatically skipped for:

- **Single-chunk files** — chunk equals file, no granularity benefit.
- **Files with 1 commit** — all chunks would get identical data.
- **Files exceeding `GIT_CHUNK_MAX_FILE_LINES`** — performance guard.
- **Binary files** — blob read fails gracefully.
- **Root commits** — no parent to diff against.

## Environment Variables

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
