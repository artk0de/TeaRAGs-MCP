---
name: tune
description:
  Auto-tune TeaRAGs performance parameters for your hardware. Benchmarks
  embedding throughput, Qdrant storage, pipeline concurrency, and git trajectory.
  Results saved to ~/.tea-rags/setup-progress.json and displayed as a summary.
  Can be run standalone or as part of /tea-rags-setup:install.
argument-hint: [--provider ollama|onnx] [--full]
---

# TeaRAGs Performance Tuning

Runs `tea-rags tune` to find optimal performance parameters for your hardware,
then saves results to the setup progress file for use in MCP configuration.

## Prerequisites

- `tea-rags` must be installed (`tea-rags --version` works)
- Qdrant must be running (embedded, Docker, or native)
- Embedding provider must be available (Ollama running or ONNX built-in)

## Instructions

### 1. Determine parameters

Check if arguments were provided. If not, check progress file for saved values.

**Provider**: from argument `--provider`, or progress file `embeddingProvider`,
or detect from current MCP config. Default: `ollama`.

**Full mode**: from argument `--full`. Default: quick mode (~2-3 min).

**Qdrant URL**: from progress file `qdrantUrl`, or auto-detect (embedded).

**Embedding URL**: from progress file or default `http://localhost:11434`.

### 2. Run the benchmark

Execute in background (this takes 2-3 minutes in quick mode, 10-15 in full):

```bash
tea-rags tune \
  --provider <provider> \
  --qdrant-url <url> \
  --embedding-url <url> \
  [--full]
```

Show the user: "Running performance benchmark (~2-3 min). This tests embedding
throughput, Qdrant storage speed, and pipeline concurrency."

**Do NOT run in a background agent** — the output is useful for the user to see
progress in real time. Run in foreground via Bash tool with a 600000ms timeout.

### 3. Parse results

After tune completes, read `tuned_environment_variables.env` from the project
root (or current directory).

Extract these values:

| Variable                              | Description                                |
| ------------------------------------- | ------------------------------------------ |
| `EMBEDDING_BATCH_SIZE`                | Optimal embedding batch size               |
| `EMBEDDING_CONCURRENCY`               | Optimal embedding concurrency              |
| `QDRANT_UPSERT_BATCH_SIZE`            | Optimal Qdrant batch size                  |
| `QDRANT_BATCH_ORDERING`               | Optimal ordering mode (weak/medium/strong) |
| `QDRANT_FLUSH_INTERVAL_MS`            | Optimal flush interval                     |
| `BATCH_FORMATION_TIMEOUT_MS`          | Optimal batch formation timeout            |
| `QDRANT_DELETE_BATCH_SIZE`            | Optimal delete batch size                  |
| `QDRANT_DELETE_CONCURRENCY`           | Optimal delete concurrency                 |
| `INGEST_TUNE_CHUNKER_POOL_SIZE`       | Optimal chunker pool size                  |
| `INGEST_TUNE_FILE_CONCURRENCY`        | Optimal file concurrency                   |
| `INGEST_TUNE_IO_CONCURRENCY`          | Optimal IO concurrency                     |
| `QDRANT_TUNE_DELETE_FLUSH_TIMEOUT_MS` | Optimal delete flush timeout               |
| `EMBEDDING_TUNE_MIN_BATCH_SIZE`       | Optimal min batch size                     |
| `TRAJECTORY_GIT_CHUNK_CONCURRENCY`    | Optimal git chunk concurrency              |

Also extract performance metrics from comments:

- `Embedding rate: N chunks/s`
- `Storage rate: N chunks/s`
- `Deletion rate: N del/s`

### 4. Save to progress

Use the progress script to save tuned values:

```bash
SCRIPTS="${CLAUDE_PLUGIN_ROOT}/scripts/setup/unix"  # or windows/
$SCRIPTS/progress.sh set tuneValues '{"EMBEDDING_BATCH_SIZE":"256",...}'
$SCRIPTS/progress.sh set steps.tune '{"status":"completed","at":"<now>"}'
```

If progress file doesn't exist, create it first:

```bash
$SCRIPTS/progress.sh init
```

### 5. Show summary

Display results to the user:

```
Performance tuning complete!

Embedding:  BATCH_SIZE=256, CONCURRENCY=4
            Throughput: 1200 chunks/sec

Qdrant:     UPSERT_BATCH_SIZE=384, ORDERING=weak
            FLUSH_INTERVAL=100ms, FORMATION_TIMEOUT=2000ms
            Storage: 3500 chunks/sec

Pipeline:   CHUNKER_POOL=4, FILE_CONC=50, IO_CONC=50

Estimated indexing times:
  Small project  (50K LoC):  ~30s
  Medium project (200K LoC): ~2min
  Large project  (1M LoC):   ~10min

Results saved to ~/.tea-rags/setup-progress.json
Use /tea-rags-setup:install to apply these values to your MCP config.
```

### 6. Clean up

Delete `tuned_environment_variables.env` after parsing — values are now in
progress file.

## ONNX (beta)

ONNX tune is not yet fully supported. When provider is `onnx`:

- Run tune anyway — embedding calibration works for ONNX
- Qdrant benchmarks work regardless of provider
- Pipeline benchmarks work regardless of provider
- If tune fails for ONNX, save default values and warn the user

## Error Handling

- **tea-rags not installed**: show error, suggest `/tea-rags-setup:install`
- **Qdrant not running**: show error with specific fix (start Docker, brew
  services start, etc.)
- **Ollama not running**: show error, suggest starting Ollama
- **Tune fails mid-run**: save partial results if env file exists, warn user
- **Tune times out (>10 min quick, >20 min full)**: kill process, save defaults

## Do NOT

- Run tune in a background agent (user needs to see real-time progress)
- Skip saving results to progress file
- Leave tuned_environment_variables.env on disk after parsing
- Assume default values without running tune (always try to run first)
