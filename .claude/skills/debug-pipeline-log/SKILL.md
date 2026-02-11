---
name: debug-pipeline-log
description: Analyze the latest pipeline debug log for performance bottlenecks, timing issues, and anomalies. Use when indexing is slow, git blame takes too long, or pipeline behavior is unexpected.
argument-hint: [log-file-path]
allowed-tools: Read, Grep, Glob, Bash(ls*), Bash(wc*)
---

# Pipeline Log Debugger

Analyze the pipeline debug log to identify performance bottlenecks and anomalies.

## Step 1: Find the log

If `$ARGUMENTS` is provided, use that path. Otherwise find the latest log:

```
~/.tea-rags-mcp/logs/pipeline-*.log
```

Pick the most recent file by modification time.

## Step 2: Read and parse the log

Read the full log file. Extract these sections:

1. **ENV block** (lines between `===` markers) — configuration snapshot
2. **Event timeline** — all `[+ Ns]` timestamped lines
3. **SUMMARY block** — JSON stats after `SUMMARY for ChunkPipeline`
4. **STAGE PROFILING table** — cumulative/wall/~added per stage
5. **GitEnrich phases** — PREFETCH_START, PREFETCH_COMPLETE, START, COMPLETE

## Step 3: Compute key metrics

From the parsed data, calculate:

### Timing
- **Scan duration**: first scan event to last scan event
- **Parse wall time**: from STAGE PROFILING table
- **Embedding wall time**: first EMBED_CALL to last BATCH_COMPLETE
- **Git blame duration**: PREFETCH_COMPLETE.durationMs (or PREFETCH_START to PREFETCH_COMPLETE timestamps)
- **setPayload duration**: GitEnrich START to COMPLETE
- **Total pipeline wall**: PIPELINE_START to PIPELINE_SHUTDOWN_START
- **Total with git**: PIPELINE_START to final GitEnrich COMPLETE

### Throughput
- **Chunks/sec**: chunksProcessed / uptimeMs * 1000
- **Embed calls**: count of EMBED_CALL events
- **Avg embed latency**: mean of all EMBED_CALL durationMs values
- **Embed latency trend**: are later batches slower? (GPU thermal throttling)

### Concurrency utilization
- **EMBEDDING_CONCURRENCY** from ENV
- **GIT_ENRICHMENT_CONCURRENCY** from ENV
- **activeWorkers max** from QUEUE_STATE events
- **Backpressure events**: count of BACKPRESSURE_ON / BACKPRESSURE_OFF, total time under backpressure

### Git blame analysis (if present)
- **Files blamed**: from PREFETCH_COMPLETE
- **Blame time per file**: durationMs / prefetched
- **Blame vs embedding ratio**: blame_duration / embedding_wall_time
- **Overlap efficiency**: how much blame overlapped with embedding (1.0 = perfect overlap)

## Step 4: Identify bottlenecks

Apply these diagnostic rules:

### Rule 1: Blame slower than embedding
If `blame_duration > embedding_wall_time`:
- **Diagnosis**: Git blame is the bottleneck, not GPU
- **Impact**: `blame_duration - embedding_wall_time` seconds wasted waiting
- **Fix**: Increase `GIT_ENRICHMENT_CONCURRENCY` (currently blame is CPU-bound, embedding is GPU-bound, they don't compete)
- **Target**: Set concurrency so `blame_duration < embedding_wall_time`

### Rule 2: Embedding latency degradation
If later EMBED_CALL durations are >50% higher than first calls:
- **Diagnosis**: GPU thermal throttling or memory pressure
- **Fix**: Reduce `EMBEDDING_CONCURRENCY` or add cooling pauses

### Rule 3: Excessive backpressure
If backpressure is ON for >30% of pipeline time:
- **Diagnosis**: GPU can't keep up with file processing
- **Fix**: Reduce `FILE_PROCESSING_CONCURRENCY` or increase `EMBEDDING_BATCH_SIZE`

### Rule 4: Parse dominates
If parse wall% > 30%:
- **Diagnosis**: Tree-sitter chunking is slow
- **Fix**: Increase `CHUNKER_POOL_SIZE`

### Rule 5: Queue starvation
If `activeWorkers < EMBEDDING_CONCURRENCY` for extended periods (no backpressure):
- **Diagnosis**: File processing too slow to feed GPU
- **Fix**: Increase `FILE_PROCESSING_CONCURRENCY`

### Rule 6: setPayload too slow
If GitEnrich COMPLETE durationMs > 30s:
- **Diagnosis**: Qdrant setPayload is bottleneck (should be fast with L1 cache)
- **Fix**: Check if blame prefetch actually ran (PREFETCH_COMPLETE should appear BEFORE enrichment START)

### Rule 7: No git overlap
If PREFETCH_START timestamp == PREFETCH_COMPLETE timestamp (or no PREFETCH events):
- **Diagnosis**: Blame ran sequentially, not in parallel with embedding
- **Fix**: Verify `CODE_ENABLE_GIT_METADATA=true` and blame worker is started

## Step 5: Output report

Format the report as:

```
## Pipeline Debug Report

### Configuration
<key ENV values as table>

### Timeline
<ASCII timeline showing phases with timestamps>

### Performance Metrics
| Metric | Value | Status |
|--------|-------|--------|
<metrics with OK/WARN/CRITICAL status>

### Bottleneck Analysis
<ordered list of issues found, most impactful first>

### Recommendations
<specific tuning suggestions with expected impact>
```

### Timeline format example:
```
  +0s     +26s                    +101s         +244s    +260s
  |--------|========================|              |========|
  scan     embedding (75s)                        setPayload (15s)
           |================================================|
           git blame (218s) <<<< BOTTLENECK
```

### Status thresholds:
- **OK**: metric within expected range
- **WARN**: metric 1.5-3x expected (performance impact)
- **CRITICAL**: metric >3x expected (major bottleneck)
