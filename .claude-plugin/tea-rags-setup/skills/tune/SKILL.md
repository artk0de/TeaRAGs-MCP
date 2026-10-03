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

Runs `tea-rags tune` to find optimal hardware perf params, saves results to
setup progress file for MCP config.

## Prerequisites

- `tea-rags` installed (`tea-rags --version` works)
- Qdrant running (embedded, Docker, or native)
- Embedding provider available (Ollama running or ONNX built-in)

## Instructions

### 1. Determine parameters

Check args provided. If not, check progress file for saved values.

**Provider**: from arg `--provider`, or progress file `embeddingProvider`, or
detect from current MCP config. Default: `ollama`. Provider `llama-server` →
skip sections 1a–6, follow "llama-server" section.

**Full mode**: from arg `--full`. Default: quick mode (~2-3 min).

**Qdrant URL**: omit `--qdrant-url` when possible — see section 1a. Use progress
file `qdrantUrl` only when real external URL.

**Embedding URL**: from progress file or default `http://localhost:11434`.

### 1a. Embedded Qdrant: do NOT pass --qdrant-url (CRITICAL for the install wizard)

**Why this matters.** Install wizard runs tune at step 6, BEFORE MCP harness
configured at step 8. At tune time:

- MCP server not in `~/.claude.json` yet, so `mcp__tea-rags__*` tools
  unavailable.
- Embedded Qdrant daemon not started by anyone — `setup-qdrant.sh embedded` only
  downloaded binary.
- Embedded daemon binds RANDOM port, not 6333, so hard-coding
  `--qdrant-url http://localhost:6333` fails with connection error.

**What to do.** Omit `--qdrant-url`. `tea-rags tune` CLI handles full cascade
internally:

1. Probes `http://localhost:6333` — uses it if Docker/native Qdrant answers.
2. Otherwise spawns embedded daemon from `~/.tea-rags/qdrant/` (downloads binary
   first if needed), reads random port from `daemon.port`, targets
   `http://127.0.0.1:<port>` for benchmark.
3. Releases daemon ref on exit so idle watcher shuts it down ~30 s later if
   nothing else using it.

**When to pass `--qdrant-url` explicitly.** Only if `qdrantMode` is `docker` or
`native` and progress file `qdrantUrl` is real http URL (not literal string
`"embedded"`). For embedded mode progress file value is `"embedded"` — a marker,
not a URL, must NOT be passed on command line.

**Sanity check before invoking tune in embedded mode:**

```bash
# Confirm the embedded binary is present — tune relies on it.
test -x "$HOME/.tea-rags/qdrant/bin/qdrant" || echo "Embedded binary missing — re-run setup-qdrant.sh embedded"
```

### 2. Run the benchmark

Execute in background (2-3 min quick mode, 10-15 full):

```bash
tea-rags tune \
  --provider <provider> \
  [--qdrant-url <url>] \       # OMIT for embedded mode (tune auto-spawns daemon)
  --embedding-url <url> \
  [--full]
```

Show the user: "Running performance benchmark (~2-3 min). This tests embedding
throughput, Qdrant storage speed, and pipeline concurrency."

**Do NOT run in a background agent** — output useful for user to see progress
real time. Run foreground via Bash tool with 600000ms timeout.

### 3. Parse results

After tune completes, read `tuned_environment_variables.env` from project root
(or current directory).

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

Also extract perf metrics from comments:

- `Embedding rate: N chunks/s`
- `Storage rate: N chunks/s`
- `Deletion rate: N del/s`

### 4. Save to progress

Use progress script to save tuned values:

```bash
SCRIPTS="${CLAUDE_PLUGIN_ROOT}/scripts/setup/unix"  # or windows/
$SCRIPTS/progress.sh set tuneValues '{"EMBEDDING_BATCH_SIZE":"256",...}'
$SCRIPTS/progress.sh set steps.tune '{"status":"completed","at":"<now>"}'
```

If progress file missing, create it first:

```bash
$SCRIPTS/progress.sh init
```

### 5. Show summary

Display results to user:

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

Delete `tuned_environment_variables.env` after parsing — values now in progress
file.

## llama-server

`tea-rags tune` CLI accepts only `ollama|onnx` — NEVER pass `llama-server`.
Instead: sweep server-side `-np` (`--slots`) on RUNNING instances. tea-rags
spawns nothing; operator restarts each instance.

Client batch size + concurrency = runtime tuner's job (hill-climb, persisted per
endpoint). Do NOT tune them, do NOT write `EMBEDDING_BATCH_SIZE` /
`EMBEDDING_CONCURRENCY` / `EMBEDDING_TUNE_MIN_BATCH_SIZE` — a pin caps the
climb.

### L1. Inputs

From progress: `llamaServer` (`os`, `advertise`, `builds[]` of
`{bin, devices}`), `embeddingBaseUrl`, `embeddingApiKey`. Missing → run install
step 4L first. Every peer must answer `curl -sf <url>/health`.

### L2. Sweep `-np` 1 → 2 → 4 → 8

Per value N:

1. Print restart lines: `tea-rags llama-server command` with saved
   `--os --bin --device --advertise [--api-key] [--port]` plus `--slots N`. Hand
   LAUNCH lines only (skip download/firewall/autostart) → user stops current
   instances, starts new ones, confirms via AskUserQuestion.
2. Wait `/health` 200 on every peer.
3. Benchmark all peers concurrently, ≥N in-flight requests per peer so every
   slot stays busy: POST `<url>/v1/embeddings`
   `{"input":[...64 code-sized texts...]}` (header `Authorization: Bearer <key>`
   if key), ~30 s per peer. Record texts/s per peer and summed.
4. Gain <5% vs previous N, or OOM / launch failure → stop, keep previous N.

Reference: RX 7800M + M3 Pro optimum = 4 (the `--slots` default).

### L3. Re-print with best `--slots`

Run `command` again with `--slots <best>` and `--autostart` → hand FULL sheet
(autostart entry must carry new `-np`). Save
`$SCRIPTS/progress.sh set llamaServer.slots <best>` and mark `steps.tune`
completed. Non-embedding keys: run nothing, use `reference.md` "Tune Defaults"
minus the three embedding keys above.

### L4. Context invariant

`command` prints `-c = slots*8192` — 8192 per slot is jina's context. Never
hand-edit `-c` / `-b` / `-ub`: per-slot context ≠ 8192 changes chunk size →
`--force` reindex needed. Change `--slots` only via `command`.

Summary shows: texts/s per N, best N, per-peer split.

## ONNX (beta)

ONNX tune not yet fully supported. When provider is `onnx`:

- Run tune anyway — embedding calibration works for ONNX
- Qdrant benchmarks work regardless of provider
- Pipeline benchmarks work regardless of provider
- If tune fails for ONNX, save default values and warn user

## Error Handling

- **tea-rags not installed**: show error, suggest `/tea-rags-setup:install`
- **Qdrant not running**: show error with specific fix (start Docker, brew
  services start, etc.). For embedded mode should never happen — tune spawns
  daemon itself. If it does, check embedded binary at
  `~/.tea-rags/qdrant/bin/qdrant` and re-run `setup-qdrant.sh embedded`.
- **`Cannot connect to Qdrant at http://localhost:6333` in embedded mode**: you
  passed `--qdrant-url` explicitly with literal string `"embedded"` or
  `http://localhost:6333`. Re-run tune WITHOUT `--qdrant-url` — see section 1a.
- **Ollama not running**: show error, suggest starting Ollama
- **Tune fails mid-run**: save partial results if env file exists, warn user
- **Tune times out (>10 min quick, >20 min full)**: kill process, save defaults

## Do NOT

- Run tune in background agent (user needs real-time progress)
- Skip saving results to progress file
- Leave tuned_environment_variables.env on disk after parsing
- Assume default values without running tune (always try to run first)
- Pass `--provider llama-server` to `tea-rags tune` CLI — unsupported
- Restart llama-server yourself on GPU host — print lines, user runs them
