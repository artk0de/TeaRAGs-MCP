---
title: Indexing Pipeline
sidebar_position: 4
---

# Indexing Pipeline

import MermaidTeaRAGs from '@site/src/components/MermaidTeaRAGs';

The indexing pipeline converts a codebase directory into a populated Qdrant collection. It runs in two flavours — **full index** (first time, or `forceReindex: true`) and **incremental reindex** (subsequent runs) — both built on the same stages.

For the payload written per chunk, see [Data Model](/architecture/data-model). For how `git.*` signals are computed *after* chunks land in Qdrant, see [Git Enrichment Pipeline](/architecture/git-enrichment-pipeline).

## High-Level Flow

<MermaidTeaRAGs>
{`
flowchart LR
    User[👤 index_codebase] --> Facade
    subgraph ingest["🍵 IngestFacade"]
        Facade[🧠 orchestrate<br/><small>provider + collection + pipeline</small>]
    end

    subgraph pipe["📦 IndexPipeline"]
        Scan[🔍 FileScanner<br/><small>.gitignore + .contextignore</small>]
        Setup[🗄️ setupCollection<br/><small>create · alias · snapshot</small>]
        Process[⚙️ processAndTrack<br/><small>ChunkPipeline workers</small>]
        Alias[🔀 finalizeAlias<br/><small>zero-downtime switch</small>]
        Snap[💾 saveSnapshot]
    end

    Facade --> Scan --> Setup --> Process --> Alias --> Snap

    subgraph chunk["ChunkPipeline"]
        Chunker[✂️ AST chunker<br/><small>per-language hooks</small>]
        Embed[✨ Embedding provider<br/><small>ONNX/Ollama/OpenAI/...</small>]
        Upsert[📥 batch upsert<br/><small>dense + sparse</small>]
        Chunker --> Embed --> Upsert
    end
    Process -.spawns.-> chunk

    Upsert -.on batch.-> Enrich[🧬 EnrichmentCoordinator<br/><small>git metadata · async</small>]
    Enrich --> Qdrant[(🗄️ Qdrant)]
    Upsert --> Qdrant
`}
</MermaidTeaRAGs>

Indexing returns as soon as dense chunks are stored. Git enrichment continues in the background and populates `git.*` payload asynchronously — search works immediately, trajectory-aware signals come online shortly after.

## Stages

### 1. Scan

`FileScanner` walks the codebase root and yields file paths. It reads:

- `.gitignore` — standard git ignore rules
- `.contextignore` — TeaRAGs-specific overrides (e.g. exclude generated code)
- `--ignorePatterns` — per-call overrides from the `index_codebase` tool
- Language heuristics — binary files, lockfiles, and `dist/`/`build/` folders skipped by default

**Output:** `FileList` — absolute paths, totals, per-extension counts.

### 2. Setup Collection

`IndexPipeline.setupCollection` decides whether to:

- **Create fresh** — first time, or after `forceReindex`. Allocates a new versioned collection (`{name}_{embeddingModelId}_{schemaVersion}`) and an alias pointing at it.
- **Reuse** — the alias already points at a valid collection matching the current embedding model and schema version.
- **Migrate** — collection exists but schema drifted (new indexes). [`SchemaManager`](/architecture/data-model#schema-versioning) creates missing indexes and bumps `schemaVersion`.

A **snapshot** of the current index state is written before any mutation, so interrupted runs can resume without data loss.

### 3. Process (Chunk → Embed → Upsert)

`IndexPipeline.processAndTrack` streams files through the `ChunkPipeline` worker pool. Inside the pipeline:

1. **Chunk** — AST-aware chunker splits code by language-specific hooks (Ruby uses `alwaysExtractChildren`, TypeScript uses `comment-capture` + `class-body-chunker`, etc.). Markdown is split by heading hierarchy.
2. **Build payload** — [`StaticPayloadBuilder`](/architecture/data-model#base--always-present) writes the base payload (content, relativePath, symbolId, imports, navigation, …).
3. **Embed** — the embedding provider (ONNX / Ollama / OpenAI / Cohere / Voyage) computes a dense vector per chunk. Configurable batch size via `EMBEDDING_TUNE_BATCH_SIZE`.
4. **Sparse vectors** — when hybrid is enabled, BM25 token frequencies are computed alongside.
5. **Batch upsert** — dense + sparse + payload written to Qdrant in configurable batches. Concurrency controlled by `INGEST_PIPELINE_CONCURRENCY` (default 1 — most providers are bottlenecked inside, not in flight).

Each batch triggers `onBatchUpserted` → `EnrichmentCoordinator.onChunksStored`, queuing git enrichment **asynchronously** so indexing throughput isn't blocked by git log parsing.

### 4. Finalize Alias

Once all chunks are upserted, `finalizeAlias` atomically switches the public alias from the old collection (if any) to the new one. Search traffic sees zero downtime — clients query the alias, not the underlying collection name.

### 5. Snapshot

A compact snapshot of file hashes is persisted to `~/.tea-rags/snapshots/{collection}.json` (sharded for large repos). Subsequent `reindex_changes` calls diff the snapshot against the current working tree to find only-changed files.

## Incremental Reindex

`ReindexPipeline.reindexChanges` skips the full walk:

1. **Prepare context** — load snapshot, resolve collection via alias.
2. **Run migrations** — reconcile any schema drift without re-embedding.
3. **Diff files** — compare current hashes against snapshot → three lists: `added`, `modified`, `deleted`.
4. **Execute parallel pipelines** — `ParallelSynchronizer` runs `DeletionStrategy` (remove deleted/modified chunks) and a regular `ChunkPipeline` (index added/modified) concurrently on the same collection.
5. **Finalize** — refresh alias, save updated snapshot.

Incremental reindex is typically 10–100× faster than a full run because embedding (the dominant cost) only runs on changed files.

## Enrichment Handoff

The enrichment pipeline is structurally separate from indexing:

| Aspect | Indexing | Enrichment |
|--------|----------|------------|
| Trigger | `index_codebase` / `reindex_changes` | `onChunksStored` hook (after each batch) |
| Blocks return? | Yes — must finish before alias switch | No — async, continues after |
| Writes to | Base payload (content, structure) | `git.*` payload via `batchSetPayload` |
| Failure mode | Aborts the index | Logged, chunk keeps base payload |

This separation means users get working search within seconds even on fresh indexes of millions-of-lines repos — ranking by trajectory signals just warms up in the background. Check status with `get_index_status`.

## Parallelism Summary

| Axis | Mechanism | Tuning |
|------|-----------|--------|
| File discovery | Sequential (IO-bound, fast) | — |
| Chunking | Worker pool | `INGEST_TUNE_CHUNKER_POOL_SIZE` |
| Embedding | Provider batches + optional concurrency | `EMBEDDING_TUNE_BATCH_SIZE`, `INGEST_PIPELINE_CONCURRENCY` |
| File-level concurrency | `BaseIndexingPipeline` | `INGEST_TUNE_FILE_CONCURRENCY` |
| Qdrant upserts | Async batch queue | `INGEST_BATCH_SIZE` |
| Git enrichment | Chunk-level worker pool | `TRAJECTORY_GIT_CHUNK_CONCURRENCY` |

See [Performance Tuning](/config/performance-tuning) for recommended values per hardware profile.

## Where Code Lives

| Stage | Source |
|-------|--------|
| Orchestration | `src/core/api/internal/facades/ingest-facade.ts` (`IngestFacade`) |
| Full index | `src/core/domains/ingest/indexing.ts` (`IndexPipeline`) |
| Incremental | `src/core/domains/ingest/reindexing.ts` (`ReindexPipeline`) |
| File scanning | `src/core/domains/ingest/pipeline/scanner.ts` (`FileScanner`) |
| Chunk pipeline | `src/core/domains/ingest/pipeline/chunk-pipeline.ts` (`ChunkPipeline`) |
| Chunker hooks | `src/core/domains/ingest/pipeline/chunker/hooks/` |
| Payload builder | `src/core/domains/trajectory/static/provider.ts` |
| Enrichment hook | `src/core/domains/ingest/pipeline/enrichment/coordinator.ts` |
| Alias / snapshot | `src/core/domains/ingest/sync/`, `src/core/domains/ingest/alias-cleanup.ts` |

## Related

- [Data Model](/architecture/data-model) — payload fields produced by this pipeline
- [Git Enrichment Pipeline](/architecture/git-enrichment-pipeline) — what runs after `onChunksStored`
- [Indexing Repositories](/usage/indexing-repositories) — user-facing guide with environment variables
