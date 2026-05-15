---
name: tune
description:
  Benchmark this hardware and write optimal performance parameters
  (embedding throughput, Qdrant storage, pipeline concurrency, git
  trajectory) into ~/.tea-rags/setup-progress.json. Triggers on "indexing
  is slow", "tune performance", "benchmark my hardware", "find optimal
  batch sizes", "поднастрой производительность". NOT for first-time
  install — use install for that. Can run standalone or as part of
  /tea-rags-setup:install.
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

**Qdrant URL**: omit `--qdrant-url` whenever possible — see section 1a. Use the
value from progress file `qdrantUrl` only when it is a real external URL.

**Embedding URL**: from progress file or default `http://localhost:11434`.

### 1a. Embedded Qdrant: do NOT pass --qdrant-url (CRITICAL for the install wizard)

**Why this matters.** The install wizard runs tune at step 6, BEFORE the MCP
harness is configured at step 8. That means at tune time:

- The MCP server is not in `~/.claude.json` yet, so `mcp__tea-rags__*` tools are
  unavailable to you.
- The embedded Qdrant daemon has not been started by anyone —
  `setup-qdrant.sh embedded` only downloaded the binary.
- The embedded daemon binds a RANDOM port, not 6333, so hard-coding
  `--qdrant-url http://localhost:6333` will fail with a connection error.

**What to do.** Just omit `--qdrant-url`. The `tea-rags tune` CLI handles the
full cascade internally:

1. Probes `http://localhost:6333` — uses it if a Docker/native Qdrant answers.
2. Otherwise spawns the embedded daemon from `~/.tea-rags/qdrant/` (downloads
   the binary first if needed), reads its random port from `daemon.port`, and
   targets `http://127.0.0.1:<port>` for the benchmark.
3. Releases the daemon ref on exit so the idle watcher can shut it down ~30 s
   later if nothing else is using it.

**When to pass `--qdrant-url` explicitly.** Only if `qdrantMode` is `docker` or
`native` and the progress file's `qdrantUrl` is a real http URL (not the literal
string `"embedded"`). For embedded mode the value in the progress file is
`"embedded"` — that is a marker, not a URL, and must NOT be passed on the
command line.

**Sanity check before invoking tune in embedded mode:**

```bash
# Confirm the embedded binary is present — tune relies on it.
test -x "$HOME/.tea-rags/qdrant/bin/qdrant" || echo "Embedded binary missing — re-run setup-qdrant.sh embedded"
```

### 2. Run the benchmark

Execute in background (this takes 2-3 minutes in quick mode, 10-15 in full):

```bash
tea-rags tune \
  --provider <provider> \
  [--qdrant-url <url>] \       # OMIT for embedded mode (tune auto-spawns daemon)
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
  services start, etc.). For embedded mode this should never happen — tune
  spawns the daemon itself. If it does, check the embedded binary at
  `~/.tea-rags/qdrant/bin/qdrant` and re-run `setup-qdrant.sh embedded`.
- **`Cannot connect to Qdrant at http://localhost:6333` in embedded mode**: you
  passed `--qdrant-url` explicitly with the literal string `"embedded"` or
  `http://localhost:6333`. Re-run tune WITHOUT `--qdrant-url` — see section 1a.
- **Ollama not running**: show error, suggest starting Ollama
- **Tune fails mid-run**: save partial results if env file exists, warn user
- **Tune times out (>10 min quick, >20 min full)**: kill process, save defaults

## Do NOT

- Run tune in a background agent (user needs to see real-time progress)
- Skip saving results to progress file
- Leave tuned_environment_variables.env on disk after parsing
- Assume default values without running tune (always try to run first)
