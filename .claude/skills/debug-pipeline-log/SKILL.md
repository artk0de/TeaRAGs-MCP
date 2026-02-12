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
5. **GitEnrich phases** — PREFETCH_START, PREFETCH_COMPLETE, STREAMING_APPLY, FLUSH_APPLY, CHUNK_CHURN_START/COMPLETE, ALL_COMPLETE

## Step 3: Compute key metrics

From the parsed data, calculate:

### Timing
- **Scan duration**: first scan event to last scan event
- **Parse wall time**: from STAGE PROFILING table
- **Embedding wall time**: first EMBED_CALL to last BATCH_COMPLETE
- **Git log prefetch duration**: PREFETCH_COMPLETE.durationMs (CLI `git log --numstat HEAD`)
- **Streaming apply duration**: sum of STREAMING_APPLY events
- **Flush apply duration**: sum of FLUSH_APPLY events
- **Chunk churn duration**: CHUNK_CHURN_COMPLETE.durationMs
- **Total pipeline wall**: PIPELINE_START to PIPELINE_SHUTDOWN_START
- **Total with enrichment**: PIPELINE_START to ALL_COMPLETE

### Throughput
- **Chunks/sec**: chunksProcessed / uptimeMs * 1000
- **Embed calls**: count of EMBED_CALL events
- **Avg embed latency**: mean of all EMBED_CALL durationMs values
- **Embed latency trend**: are later batches slower? (GPU thermal throttling)

### Concurrency utilization
- **EMBEDDING_CONCURRENCY** from ENV
- **activeWorkers max** from QUEUE_STATE events
- **Backpressure events**: count of BACKPRESSURE_ON / BACKPRESSURE_OFF, total time under backpressure

### Git enrichment analysis (if present)
- **Files in git log**: from PREFETCH_COMPLETE
- **Prefetch time**: durationMs from PREFETCH_COMPLETE
- **Prefetch vs embedding ratio**: prefetch_duration / embedding_wall_time
- **Streaming overlap**: overlapMs and overlapRatio from ALL_COMPLETE (1.0 = perfect overlap)
- **Estimated savings**: estimatedSavedMs from ALL_COMPLETE (ms saved by streaming vs sequential)
- **Path match rate**: matchedFiles / (matchedFiles + missedFiles) — should be >90%
- **Streaming vs flush applies**: streamingApplies (during embedding) vs flushApplies (after)

### Chunk churn analysis (if present)
- **Overlays applied**: overlaysApplied from CHUNK_CHURN_COMPLETE
- **Duration**: durationMs from CHUNK_CHURN_COMPLETE
- **Overlays/sec**: overlaysApplied / (durationMs / 1000)

## Step 4: Identify bottlenecks

Apply these diagnostic rules:

### Rule 1: Git prefetch slower than embedding
If `prefetch_duration > embedding_wall_time`:
- **Diagnosis**: Git log is the bottleneck, not GPU
- **Impact**: `prefetch_duration - embedding_wall_time` seconds wasted waiting
- **Fix**: Check repo size, consider reducing `GIT_LOG_MAX_AGE_MONTHS`
- **Note**: CLI runs `git log HEAD --numstat` — single-threaded, no concurrency knob

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

### Rule 6: Low path match rate
If `matchedFiles / (matchedFiles + missedFiles) < 0.8`:
- **Diagnosis**: Git log paths don't match indexed file paths
- **Impact**: 1 - matchRate fraction of files get no git metadata
- **Check**: missedPathSamples in ALL_COMPLETE for pattern (leading slashes, wrong prefix, etc.)
- **Fix**: Verify repo root detection, check if files are outside git tree

### Rule 7: No streaming overlap
If `overlapRatio < 0.5` or `streamingApplies == 0`:
- **Diagnosis**: Enrichment didn't overlap with embedding (ran sequentially)
- **Impact**: Lost `estimatedSavedMs` of potential time savings
- **Fix**: Verify `CODE_ENABLE_GIT_METADATA=true` and enrichment starts before embedding

### Rule 8: Chunk churn timeout
If CHUNK_CHURN_FAILED appears or CHUNK_CHURN_COMPLETE is missing:
- **Diagnosis**: Chunk-level git analysis timed out or crashed
- **Fix**: Increase `GIT_CHUNK_TIMEOUT_MS` (default 120s), reduce `GIT_CHUNK_MAX_AGE_MONTHS`, or set `GIT_CHUNK_ENABLED=false` for very large repos
- **Note**: Large repos (>20k files) may need 5-10min for chunk churn

### Rule 9: enrichApply too slow
If enrichApply wall time > 60s:
- **Diagnosis**: Qdrant setPayload is bottleneck
- **Fix**: Check Qdrant health, verify payloads are small

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

### Enrichment Analysis
| Metric | Value | Status |
|--------|-------|--------|
| Path match rate | X% (matched/total) | OK/WARN/CRITICAL |
| Streaming overlap | X% (Xms saved) | OK/WARN |
| Streaming applies | X during / Y after | ... |
| Chunk churn | X overlays in Ys | OK/TIMEOUT |

### Bottleneck Analysis
<ordered list of issues found, most impactful first>

### Recommendations
<specific tuning suggestions with expected impact>
```

### Timeline format example:
```
  +0s     +26s                    +101s         +244s    +260s   +525s
  |--------|========================|              |========|       |
  scan     embedding (75s)                        enrichApply     chunk churn
           |================================================|     (265s background)
           git log prefetch (93s, 100% overlap)             |
                                                           ALL_COMPLETE
```

### Status thresholds:
- **OK**: metric within expected range
- **WARN**: metric 1.5-3x expected (performance impact)
- **CRITICAL**: metric >3x expected (major bottleneck)

### ENV reference (current defaults):
| Variable | Default | Purpose |
|----------|---------|---------|
| `EMBEDDING_CONCURRENCY` | 1 | Parallel embedding workers |
| `EMBEDDING_BATCH_SIZE` | 1024 | Chunks per embed call |
| `CHUNKER_POOL_SIZE` | 4 | Tree-sitter parser workers |
| `FILE_PROCESSING_CONCURRENCY` | 50 | Parallel file readers |
| `CODE_ENABLE_GIT_METADATA` | false | Enable git enrichment |
| `GIT_LOG_MAX_AGE_MONTHS` | 12 | Git history window |
| `GIT_LOG_TIMEOUT_MS` | 60000 | Git log prefetch timeout |
| `GIT_CHUNK_ENABLED` | true | Enable chunk-level churn |
| `GIT_CHUNK_TIMEOUT_MS` | 120000 | Chunk churn timeout |
| `GIT_CHUNK_MAX_AGE_MONTHS` | 6 | Chunk churn history window |
| `GIT_CHUNK_CONCURRENCY` | 10 | Chunk churn pathspec batches |
| `GIT_CHUNK_MAX_FILE_LINES` | 10000 | Skip huge files in chunk churn |
