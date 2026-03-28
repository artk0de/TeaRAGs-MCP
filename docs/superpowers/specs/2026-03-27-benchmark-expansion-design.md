# Benchmark Expansion — Design Spec

**Epic:** tea-rags-mcp-lpw3
**Date:** 2026-03-27

## Problem

`npm run tune` benchmarks 8 variables (embedding batch/concurrency, qdrant
upsert/ordering/flush/formation/delete). But the pipeline has 13+ more
performance-sensitive parameters that are left at hardcoded defaults. Users on
different hardware get suboptimal performance for CPU-bound (chunker pool), I/O-bound
(file/sync concurrency), and git trajectory operations.

## Scope

Three phases, each additive to `tune.mjs`:

| Phase | Parameters | Nature |
|-------|-----------|--------|
| 1 — Ingest/Qdrant | CHUNKER_POOL_SIZE, FILE_CONCURRENCY, IO_CONCURRENCY, DELETE_FLUSH_TIMEOUT_MS, EMBEDDING_MIN_BATCH_SIZE | CPU/IO-bound, uses real files |
| 2 — Git Trajectory | GIT_CHUNK_CONCURRENCY, GIT_LOG_TIMEOUT_MS | Git I/O-bound, uses real repo |
| 3 — ONNX Provider | Embedding provider abstraction | Provider-agnostic calibration |

## Phase 1: Ingest / Qdrant Gaps

### Key Design Decision: Real Files vs Synthetic

Current benchmarks use synthetic data (generated texts, pre-computed embeddings).
Phase 1 parameters are **hardware-bound** — they depend on CPU cores, disk speed,
and filesystem caching. Synthetic data would not produce meaningful results.

**Approach:** User specifies a real project path via `--path <dir>` argument.
The benchmark collects source files from that project (respecting `.contextignore`
/ `.gitignore`) and uses them as test corpus. This tunes for the user's actual
workload — file sizes, language mix, AST complexity.

```bash
npm run tune -- --path /Users/me/my-project
```

If `--path` not provided, falls back to current working directory.
Minimum file count required: 50 (below that, results are unreliable — warn and
suggest a larger project).

### 1.1 CHUNKER_POOL_SIZE

**What it controls:** Worker thread count for parallel tree-sitter AST parsing
(`ChunkerPool` in `pipeline/chunker/infra/pool.ts`).

**Benchmark design:**
- Import `ChunkerPool` from build
- Collect source files from target project (read content into memory first to isolate disk I/O)
- For each pool size: create pool → process all files → measure wall time → shutdown
- Test values: `[1, 2, 4, Math.min(8, os.cpus().length), os.cpus().length]`
- Metric: files/sec
- Search: `linearSteppingSearch` with `StoppingDecision`

**Warmup:** 1 run discarded (JIT + tree-sitter init).

**Output:** `INGEST_TUNE_CHUNKER_POOL_SIZE=<optimal>`

### 1.2 FILE_CONCURRENCY

**What it controls:** Parallel file read + chunk dispatch in `processFiles()`
(`pipeline/file-processor.ts`). Uses custom `parallelLimit()`.

**Benchmark design:**
- Cannot easily isolate `processFiles()` without full pipeline
- Instead: benchmark the `parallelLimit()` pattern directly with real file reads
- Read N files from target project with varying concurrency
- Test values: `[10, 25, 50, 100, 200]`
- Metric: files/sec (read + hash, simulating sync workload)
- Search: `linearSteppingSearch`

**Note:** FILE_CONCURRENCY and IO_CONCURRENCY gate different phases (chunking vs sync)
but both are fs-bound. We benchmark them separately because optimal values may differ
(chunking is CPU+IO, sync is pure IO).

**Output:** `INGEST_TUNE_FILE_CONCURRENCY=<optimal>`

### 1.3 IO_CONCURRENCY

**What it controls:** Parallel file I/O during cache sync
(`ParallelFileSynchronizer`). Gates hash computation + metadata reads.

**Benchmark design:**
- Simulate sync workload: read file + compute SHA256 hash (matches real sync behavior)
- Use all files from target project as corpus
- Test values: `[10, 25, 50, 100, 200]`
- Metric: files/sec (read + SHA256)
- Search: `linearSteppingSearch`

**Output:** `INGEST_TUNE_IO_CONCURRENCY=<optimal>`

### 1.4 DELETE_FLUSH_TIMEOUT_MS

**What it controls:** Flush timeout for delete `BatchAccumulator`. When partial
batch hasn't reached `minBatchSize`, waits up to this timeout before flushing.
Has adaptive deferral (max 3 defers with halving timeout).

**Benchmark design:**
- Reuse existing Qdrant benchmark infrastructure (pre-generated points)
- Insert points, then delete with varying flush timeouts
- Simulate partial batches (queue size < batchSize to trigger timeout path)
- Test values: `[250, 500, 1000, 2000, 5000]`
- Metric: deletions/sec with partial batches
- Search: `linearSteppingSearch` with `StoppingDecision`

**Output:** `QDRANT_TUNE_DELETE_FLUSH_TIMEOUT_MS=<optimal>`

### 1.5 EMBEDDING_MIN_BATCH_SIZE

**What it controls:** Minimum items in batch before timeout flush triggers.
Below this → defer (re-arm shorter timer, max 3 defers). Prevents tiny GPU batches.

**Benchmark design:**
- Use Ollama/ONNX embeddings with small tail batches
- Fix batch size at optimal (from Phase 1 of existing benchmark)
- Simulate end-of-pipeline scenario: total chunks not evenly divisible by batch size
- Test ratios of batchSize: `[0.125, 0.25, 0.5, 0.75]`
- Metric: ms per tail-batch flush (latency, not throughput)
- Compare: eager flush (ratio=0) vs deferred flush at each ratio

**Output:** `EMBEDDING_TUNE_MIN_BATCH_SIZE=<optimal>`

### Phase 1 Integration into tune.mjs

New phases inserted **before** existing Qdrant phases (since they inform pipeline
config):

```
Existing:  Embedding Calibration → Qdrant Batch → Ordering → Flush → Formation → Delete Batch → Delete Conc
New order: Embedding Calibration → CHUNKER_POOL → FILE_CONC → IO_CONC → Qdrant Batch → ... → Delete Flush → MIN_BATCH
```

CHUNKER_POOL/FILE_CONC/IO_CONC are independent of Qdrant — they run before Qdrant
tests. DELETE_FLUSH_TIMEOUT and MIN_BATCH depend on optimal delete/embedding config
so they run after their respective phases.

## Phase 2: Git Trajectory

### 2.1 GIT_CHUNK_CONCURRENCY

**What it controls:** Semaphore limit for parallel commit processing in
`buildChunkChurnMapUncached()`. Each slot: read 2 blobs + structuredPatch diff.

**Benchmark design:**
- Use target project's git repo (real history)
- Select ~20 files with highest commit count (most work for chunk churn)
- For each concurrency: run chunk churn analysis → measure wall time
- Test values: `[2, 5, 10, 20, 40]`
- Metric: commits/sec or files/sec
- Search: `linearSteppingSearch`

**Prerequisite:** Requires `TRAJECTORY_GIT_ENABLED=true` equivalent setup.

**Output:** `TRAJECTORY_GIT_CHUNK_CONCURRENCY=<optimal>`

### 2.2 GIT_LOG_TIMEOUT_MS

**What it controls:** Timeout for `git log --numstat` command. Too low = timeout
on large repos. Too high = long wait on failures.

**Benchmark design:**
- Run `git log --numstat` on current repo with varying `--since` depths
- Measure actual execution time
- Report: actual time at current depth + safety margin recommendation
- Not a search problem — measure + recommend `2× actual time` as safe default
- Test depths: 3mo, 6mo, 12mo, 24mo

**Output:** `TRAJECTORY_GIT_LOG_TIMEOUT_MS=<recommended>` (informational, not
auto-tuned)

## Phase 3: ONNX Provider

### Problem

Current benchmarks hardcode `OllamaEmbeddings`. ONNX provider has different
initialization (daemon + GPU calibration) and different performance profile.

### Design

Abstract embedding provider creation:

```javascript
// benchmarks/lib/provider.mjs
async function createEmbeddingProvider(config) {
  const provider = config.EMBEDDING_PROVIDER || "ollama";

  if (provider === "onnx") {
    const { OnnxEmbeddings } = await import("../build/core/adapters/embeddings/onnx.js");
    const onnx = new OnnxEmbeddings(config.EMBEDDING_MODEL, { ... });
    await onnx.initialize();
    return onnx;
  }

  // Default: Ollama
  const { OllamaEmbeddings } = await import("../build/core/adapters/embeddings/ollama.js");
  return new OllamaEmbeddings(config.EMBEDDING_MODEL, undefined, undefined, config.EMBEDDING_BASE_URL);
}
```

**ONNX-specific calibration:**
- ONNX already has its own probe (`worker.ts` tests `[1,4,8,16,32,64,128]`)
- Benchmark should use `recommendedBatchSize` from ONNX as starting point
- Then run same 3-phase calibration on top

**Connectivity check:** Replace Ollama-specific `/api/tags` check with
provider-agnostic `checkHealth()` method (already exists on both providers).

**Config additions:**
```
EMBEDDING_PROVIDER=ollama|onnx    # Select provider
EMBEDDING_MODEL=...                # Model name (provider-specific)
```

**Output:** Same `EMBEDDING_BATCH_SIZE`/`EMBEDDING_CONCURRENCY` but calibrated
for selected provider.

## Output File Changes

Add new variables to `tuned_environment_variables.env`:

```env
# Phase 1: Pipeline
INGEST_TUNE_CHUNKER_POOL_SIZE=<value>
INGEST_TUNE_FILE_CONCURRENCY=<value>
INGEST_TUNE_IO_CONCURRENCY=<value>
QDRANT_TUNE_DELETE_FLUSH_TIMEOUT_MS=<value>
EMBEDDING_TUNE_MIN_BATCH_SIZE=<value>

# Phase 2: Git Trajectory (informational)
TRAJECTORY_GIT_CHUNK_CONCURRENCY=<value>
# TRAJECTORY_GIT_LOG_TIMEOUT_MS=<value>  # recommendation, not auto-tuned

# Reference: Provider used
# EMBEDDING_PROVIDER=ollama|onnx
```

## Benchmark Helpers: New Functions

All new benchmark functions go in `benchmarks/lib/benchmarks.mjs`:

```javascript
// Phase 1
benchmarkChunkerPoolSize(files, poolSize)       → {poolSize, time, rate, error}
benchmarkFileConcurrency(files, concurrency)    → {concurrency, time, rate, error}
benchmarkIoConcurrency(files, concurrency)      → {concurrency, time, rate, error}
benchmarkDeleteFlushTimeout(qdrant, points, timeoutMs, optimalDeleteBatch, optimalDeleteConc)
                                                → {timeoutMs, time, rate, error}
benchmarkMinBatchSize(embeddings, texts, ratio, optimalBatchSize)
                                                → {ratio, minBatchSize, time, latencyMs, error}

// Phase 2
benchmarkGitChunkConcurrency(repoPath, files, concurrency)
                                                → {concurrency, time, rate, error}
measureGitLogDuration(repoPath, sinceMonths)    → {months, durationMs, entries}
```

## File Changes Summary

| File | Change |
|------|--------|
| `benchmarks/tune.mjs` | Add phases 9-15 (pipeline, git, min-batch) |
| `benchmarks/lib/benchmarks.mjs` | Add 7 new benchmark functions |
| `benchmarks/lib/config.mjs` | Add test values for new params, `--path` arg parsing |
| `benchmarks/lib/files.mjs` | **New** — collect source files from target project (gitignore-aware) |
| `benchmarks/lib/output.mjs` | Add new vars to env output |
| `benchmarks/lib/provider.mjs` | **New** — provider abstraction |
| `benchmarks/benchmark-embeddings.mjs` | Use provider abstraction |

## Non-Goals

- Benchmarking `QDRANT_QUANTIZATION_SCALAR` (requires search accuracy measurement, different kind of benchmark)
- Auto-tuning git timeouts (informational only)
- Benchmarking `TRAJECTORY_GIT_SQUASH_AWARE_SESSIONS` (behavioral, not performance)
- Benchmarking retry parameters (error handling, not throughput)
