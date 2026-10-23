---
name: tune
description:
  Benchmark this hardware and write optimal performance parameters
  (embedding throughput, Qdrant storage, pipeline concurrency, git
  trajectory) into ~/.tea-rags/setup-progress.json. Triggers on "indexing
  is slow", "tune performance", "benchmark my hardware", "find optimal
  batch sizes", "tune llama-server slots", "поднастрой производительность".
  llama-server: sweeps -np 1/2/4/8 on running instances. NOT for first-time
  install — use install for that. Can run standalone or as part of
  /tea-rags-setup:install.
argument-hint: [--provider ollama|onnx|llama-server] [--full]
---

# TeaRAGs Performance Tuning

`tea-rags tune` → optimal hardware perf params → setup progress file for MCP
config.

## Prerequisites

- `tea-rags` installed (`tea-rags --version` works)
- Qdrant running (embedded, Docker, or native)
- Embedding provider available (Ollama running or ONNX built-in)

## Instructions

### 1. Determine parameters

Args first, else progress file.

**Provider**: `--provider` arg, or progress `embeddingProvider`, or current MCP
config. Default `ollama`. `llama-server` → skip sections 1a–6, follow
"llama-server" section.

**Full mode**: `--full` arg. Default quick (~2-3 min).

**Qdrant URL**: omit `--qdrant-url` when possible (1a). Progress `qdrantUrl`
only when real external URL.

**Embedding URL**: progress file or default `http://localhost:11434`.

### 1a. Embedded Qdrant: do NOT pass --qdrant-url (CRITICAL for the install wizard)

Install wizard runs tune at step 6, BEFORE MCP configured (step 8): no
`mcp__tea-rags__*` tools, embedded daemon not started (`setup-qdrant.sh
embedded` only downloaded binary), daemon binds RANDOM port — hard-coded
`--qdrant-url http://localhost:6333` fails.

Omit `--qdrant-url`; `tea-rags tune` cascades itself:

1. Probes `http://localhost:6333` — Docker/native answers → uses it.
2. Else spawns embedded daemon from `~/.tea-rags/qdrant/` (downloads binary if
   needed), reads random port from `daemon.port`, targets
   `http://127.0.0.1:<port>`.
3. Releases daemon ref on exit → idle watcher stops it ~30 s later.

Pass `--qdrant-url` only if `qdrantMode` is `docker` / `native` AND progress
`qdrantUrl` is real http URL. Embedded → progress value `"embedded"` = marker,
NEVER on command line.

**Sanity check before tune in embedded mode:**

```bash
# Confirm the embedded binary is present — tune relies on it.
test -x "$HOME/.tea-rags/qdrant/bin/qdrant" || echo "Embedded binary missing — re-run setup-qdrant.sh embedded"
```

### 2. Run the benchmark

Foreground via Bash tool, 600000ms timeout (2-3 min quick, 10-15 full) — NOT a
background agent; user watches progress live.

```bash
tea-rags tune \
  --provider <provider> \
  [--qdrant-url <url>] \       # OMIT for embedded mode (tune auto-spawns daemon)
  --embedding-url <url> \
  [--full]
```

Tell user: "Running performance benchmark (~2-3 min). This tests embedding
throughput, Qdrant storage speed, and pipeline concurrency."

### 3. Parse results

Read `tuned_environment_variables.env` from project root (or cwd). Extract:

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

Perf metrics from comments:

- `Embedding rate: N chunks/s`
- `Storage rate: N chunks/s`
- `Deletion rate: N del/s`

### 4. Save to progress

```bash
SCRIPTS="${CLAUDE_PLUGIN_ROOT}/scripts/setup/unix"  # or windows/
$SCRIPTS/progress.sh set tuneValues '{"EMBEDDING_BATCH_SIZE":"256",...}'
$SCRIPTS/progress.sh set steps.tune '{"status":"completed","at":"<now>"}'
```

Progress file missing → create first:

```bash
$SCRIPTS/progress.sh init
```

### 5. Show summary

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

Delete `tuned_environment_variables.env` after parsing.

## llama-server

`tea-rags tune` CLI accepts only `ollama|onnx` — NEVER pass `llama-server`.
Instead sweep server-side `-np` (`--slots`) on RUNNING instances. tea-rags
spawns nothing; operator restarts each instance — never restart them yourself
on GPU host.

Client batch size + concurrency = runtime tuner (hill-climb, persisted per
endpoint). Do NOT tune or write `EMBEDDING_BATCH_SIZE` /
`EMBEDDING_CONCURRENCY` / `EMBEDDING_TUNE_MIN_BATCH_SIZE` — pin caps climb.

### L1. Inputs

Progress: `llamaServer` (`os`, `advertise`, `builds[]` of `{bin, devices}`),
`embeddingBaseUrl`, `embeddingApiKey`. Missing → install step 4L first. Every
peer must answer `curl -sf <url>/health`.

### L2. Sweep `-np` 1 → 2 → 4 → 8

Per N:

1. Print restart lines: `tea-rags llama-server command` w/ saved
   `--os --bin --device --advertise [--api-key] [--port]` + `--slots N`. Hand
   LAUNCH lines only (skip download/firewall/autostart) → user stops current
   instances, starts new, confirms via AskUserQuestion.
2. Wait `/health` 200 on every peer.
3. Benchmark all peers concurrently, ≥N in-flight requests per peer so every
   slot stays busy: POST `<url>/v1/embeddings`
   `{"input":[...64 code-sized texts...]}` (header `Authorization: Bearer <key>`
   if key), ~30 s per peer. Record texts/s per peer and summed.
4. Gain <5% vs previous N, or OOM / launch failure → stop, keep previous N.

Typical optimum = 4 (`--slots` default).

### L3. Re-print with best `--slots`

`command` again w/ `--slots <best>` + `--autostart` → hand FULL sheet (autostart
entry must carry new `-np`). Save
`$SCRIPTS/progress.sh set llamaServer.slots <best>`, mark `steps.tune`
completed. Non-embedding keys: run nothing, `reference.md` "Tune Defaults"
minus three embedding keys above.

### L4. Context invariant

`command` prints `-c = slots*8192` — 8192 per slot = jina context. Never
hand-edit `-c` / `-b` / `-ub`: per-slot context ≠ 8192 changes chunk size →
`--force` reindex. Change `--slots` only via `command`.

Summary: texts/s per N, best N, per-peer split.

## ONNX (beta)

ONNX tune not fully supported. Provider `onnx` → run tune anyway (embedding
calibration, Qdrant + pipeline benchmarks work); fails → save defaults, warn.

## Error Handling

- **tea-rags not installed**: show error, suggest `/tea-rags-setup:install`
- **Qdrant not running**: specific fix (start Docker, brew services start,
  etc.). Embedded → shouldn't happen (tune spawns daemon); if it does, check
  `~/.tea-rags/qdrant/bin/qdrant`, re-run `setup-qdrant.sh embedded`.
- **`Cannot connect to Qdrant at http://localhost:6333` in embedded mode**:
  `--qdrant-url` passed as `"embedded"` or `http://localhost:6333`. Re-run
  WITHOUT `--qdrant-url` (1a).
- **Ollama not running**: show error, suggest starting Ollama
- **Tune fails mid-run**: save partial results if env file exists, warn
- **Tune times out (>10 min quick, >20 min full)**: kill process, save defaults

## Do NOT

- Skip saving results to progress file
- Leave tuned_environment_variables.env on disk after parsing
- Assume defaults without running tune (always try first)
