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
        GitLog[🔀 numstat log<br/><small>VCS adapter</small>]
        FileCommits["📋 Per-file CommitInfo list<br/><small>+ linesAdded / linesDeleted</small>"]
        ComputeMeta[⚙️ computeFileSignals]
        GitFileMeta[📊 GitFileSignals<br/><small>stored on all chunks of file</small>]

        GitLog --> FileCommits --> ComputeMeta --> GitFileMeta
    end

    subgraph phase2["Phase 2: Chunk-Level Churn Overlay"]
        GitLogN[🔀 commit discovery<br/><small>VCS adapter</small>]
        DiffTrees[🔍 changed files<br/><small>parent vs commit</small>]
        FilterFiles[📁 Filter to files<br/><small>with >1 chunk in index</small>]
        ReadBlobs[📄 batch blob reads<br/><small>structuredPatch via jsdiff</small>]
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

- **Pluggable git access** — every history read (log, blame, blobs) goes
  through the VCS adapter hierarchy below, selected by `GIT_ADAPTER`.
- **Persistent batch reads** — bulk blob/OID reads share one long-lived
  backend (a `git cat-file --batch` process on the CLI engine, an open
  repository handle on es-git) instead of per-operation spawns. isomorphic-git
  was removed entirely: its pack reader loaded whole packfiles into memory.
- **Blame-backed ownership** — the `blame*` ownership family comes from
  per-line HEAD attribution via the adapter; churn metrics derive from commit
  history.
- **Background execution** — both phases run asynchronously after indexing returns.
- **HEAD-based caching** — results are cached and invalidated when HEAD changes.

## Git Access Layer — VCS Adapter Hierarchy

<MermaidTeaRAGs>
{`
flowchart LR
    Trajectory[🍵 git trajectory<br/><small>enrichment domain</small>]
    Factory[🏭 VcsAdapterFactory<br/><small>GIT_ADAPTER env</small>]

    subgraph hierarchy["VCS adapter hierarchy"]
        VcsAdapter[📜 VcsAdapter<br/><small>VCS-portable contract</small>]
        VcsGit[🔀 VcsGitAdapter<br/><small>git-family contract</small>]
        GitCli[💻 GitCliAdapter<br/><small>system git CLI</small>]
        EsGit[⚡ EsGitAdapter<br/><small>in-process libgit2</small>]

        VcsAdapter --> VcsGit
        VcsGit --> GitCli
        VcsGit --> EsGit
    end

    Trajectory --> Factory --> VcsGit
`}
</MermaidTeaRAGs>

- `VcsAdapter` — the VCS-portable subset (head, blame, numstat log, commits,
  blob reads); the top-level abstraction a future non-git VCS would implement.
- `VcsGitAdapter` — the git-strength contract the trajectory domain actually
  consumes: pathspec-filtered discovery and batch blob/OID plumbing are git
  semantics, so consumers type against this class, not the weaker portable one.
- `GitCliAdapter` — the system git binary, one process per operation; the
  reference implementation and the equivalence oracle.
- `EsGitAdapter` — [es-git](https://github.com/toss/es-git) (napi-rs over
  libgit2): the repository opens once and every read happens in-process.
  Selected with `GIT_ADAPTER=es-git`; if the binding cannot load, every git
  operation fails loudly with an install hint — no silent fallback.

Adapter instances are repo-scoped and constructed lazily per resolved
repository root; worker threads build their own instance in-thread from the
job payload (instances never cross thread boundaries). See
[Git Enrichments — Git History Engine](/usage/advanced/git-enrichments#git-history-engine)
for the user-facing guide.

## Phase 1: File-Level Enrichment

Reads git history through the active VCS adapter (`readNumstatLog`, bounded by
`TRAJECTORY_GIT_LOG_MAX_AGE_MONTHS`, default 12 months; timeout
`TRAJECTORY_GIT_LOG_TIMEOUT_MS` applies to the CLI engine).

```text
numstat log (VCS adapter: git CLI or in-process es-git)
  -> per-file CommitInfo[] + linesAdded/linesDeleted
    -> computeFileSignals()
      -> GitFileSignals (stored on all chunks of the file)
```

**Output:** `GitFileMetadata` containing commitCount, relativeChurn, recencyWeightedFreq, changeDensity, churnVolatility, bugFixRate, two parallel ownership families (`recentDominantAuthor` / `recentDominantAuthorPct` / `recentAuthors` / `recentContributorCount` from the configurable recent commit window, and `blameDominantAuthor` / `blameDominantAuthorPct` / `blameAuthors` / `blameContributorCount` from `git blame HEAD`), and other signals. Stored on **all chunks** of the file via the `git.*` payload namespace.

The two ownership families capture distinct semantics: `recent*` reflects who's been actively committing in the recent window (good for activity / review routing), while `blame*` reflects who currently owns the live lines (good for authority and knowledge-silo analysis). When a long-time owner stops committing, the two diverge, and the divergence itself carries information.

## Phase 2: Chunk-Level Churn Overlay

Walks recent commits, diffs trees, reads blobs, and computes line-level patches to determine which chunks were affected by each commit.

```text
commit discovery (VCS adapter, last N months)
  -> for each commit: changed files (parent vs commit)
    -> filter to files with >1 chunk in index
      -> batch blob reads (parent + commit) -> structuredPatch (jsdiff)
        -> hunks with line numbers -> overlaps(hunk, chunk)
          -> per-chunk accumulators -> ChunkChurnOverlay
            -> batchSetPayload with dot-notation merge
               (git.chunkCommitCount, etc.)
```

**Output:** `ChunkChurnOverlay` containing chunkCommitCount, chunkChurnRatio, `git.chunk.recentContributorCount`, `git.chunk.blameContributorCount`, chunkBugFixRate, chunkLastModifiedAt, chunkAgeDays. Merged into existing `git.*` payload using dot-notation to avoid overwriting file-level data.

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
- **Files exceeding `TRAJECTORY_GIT_CHUNK_MAX_FILE_LINES`** — performance guard.
- **Binary files** — blob read fails gracefully.
- **Root commits** — no parent to diff against.

## GIT SESSIONS — Squash-Aware Grouping {#git-sessions}

**Why it exists.** Agent-driven development produces **bursts of micro-commits**:
a single refactor session might land as 15–20 "fix typo", "adjust", "wip"
commits within a few minutes. Treating each as an independent commit wrecks
every churn-based signal — a 20-commit session looks identical to 20 separate
production incidents.

**What it does.** When `TRAJECTORY_GIT_SQUASH_AWARE_SESSIONS=true`, the pipeline
groups commits by `(author, time gap)`. Any silence gap larger than
`TRAJECTORY_GIT_SESSION_GAP_MINUTES` (default 30 min) starts a new session.
Session count — not raw commit count — then feeds churn-related signals.

**Where it matters most:**

- Solo devs pair-programming with an agent (single human + single agent author)
- Teams adopting AI-assisted workflows where agents produce fine-grained commits
- Any project where `git log --oneline | wc -l` is misleading because most
  commits are agent checkpoints, not logical deliverables

**Impact on signals.** `commitCount`, `chunkCommitCount`, `bugFixRate`,
`churnVolatility`, and `relativeChurn` all use the deduplicated session count
when this mode is on. `recentDominantAuthor`, `blameDominantAuthor`, and
`taskIds` are unaffected — sessions affect counts, not who owns lines or who
mentioned which ticket.

**Default is `false`** — opt in per project. Enable via the environment variable
or the setup wizard (`/tea-rags-setup:install` step 7 — "Configure git
analytics").

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GIT_ADAPTER` | `git` | Git history engine: `git` (system CLI) or `es-git` (in-process libgit2). Pinned per project in the registry |
| `TRAJECTORY_GIT_ENABLED` | `true` | Enable git enrichment during indexing. Set to `false` for non-git projects or fast iteration |
| `TRAJECTORY_GIT_LOG_MAX_AGE_MONTHS` | `12` | Time window for file-level git analysis (months). `0` = no age limit |
| `TRAJECTORY_GIT_LOG_TIMEOUT_MS` | `60000` | Timeout for `git log --numstat` (ms); falls back to native CLI on expiry |
| `TRAJECTORY_GIT_CHUNK_MAX_AGE_MONTHS` | `6` | Time window for chunk-level churn analysis (months). `0` = no age limit |
| `TRAJECTORY_GIT_CHUNK_CONCURRENCY` | `10` | Parallel commit processing for chunk churn |
| `TRAJECTORY_GIT_CHUNK_TIMEOUT_MS` | `120000` | Timeout for chunk churn CLI pathspec (ms) |
| `TRAJECTORY_GIT_CHUNK_MAX_FILE_LINES` | `10000` | Skip files larger than this for chunk analysis |
| `TRAJECTORY_GIT_SQUASH_AWARE_SESSIONS` | `false` | Group commits into sessions (squash noise reduction) |
| `TRAJECTORY_GIT_SESSION_GAP_MINUTES` | `30` | Gap between commits to split sessions |
