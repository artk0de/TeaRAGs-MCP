---
title: llama-server
sidebar_position: 3
---

# llama-server

Embedding provider for a standalone
[llama.cpp `llama-server`](https://github.com/ggml-org/llama.cpp/tree/master/tools/server),
usually several instances per GPU on a dedicated GPU host in your network.
TeaRAGs spreads every embedding batch across all instances and all of their
parallel slots, and falls back to a llama-server on your own machine when the
GPU host is gone.

|                   |                                                           |
| ----------------- | --------------------------------------------------------- |
| **Type**          | Local / LAN                                               |
| **Price**         | 🟢 Free                                                   |
| **Default model** | `unclemusclez/jina-embeddings-v2-base-code:latest` (GGUF) |
| **Dimensions**    | 768                                                       |
| **Default URL**   | `http://localhost:8080`                                   |

## When to use it

[Ollama](./ollama) stays the default provider: one install, one model pull, and
it is fast enough for most projects. Switch to llama-server when **both** hold:

- the project is large — **3M+ indexed lines**, where a full index runs long
  enough that embedding throughput decides the wall clock, and
- you have a GPU host (a desktop, a mini-PC with an eGPU, a server) that can
  run llama-server, ideally reachable over the LAN.

Ollama runs embedding models through its own bundled llama-server with one
slot (`-np 1`), one batch per GPU pass. A standalone llama-server with several
slots — and several instances per GPU — keeps the GPU busy. Measured on a
mini-PC host (1024 chunks of a production codebase,
`jina-embeddings-v2-base-code`, `/v1/embeddings`):

| Server | texts/s | vs Ollama |
| --- | --- | --- |
| Ollama 0.35 | 99 | 1.00× |
| llama-server Vulkan ×1, RX 7800M | 214 | 2.16× |
| llama-server Vulkan ×3, RX 7800M | 307 | 3.10× |
| llama-server Vulkan ×3 RX 7800M + ×1 Arc 140T | 334 | 3.37× |
| Same, GPU power boost on | 387 | 3.91× |
| Mac fallback: Ollama → llama-server ×2 (M3 Pro) | 55 → 93.5 | 1.69× |

`×N` is the number of llama-server processes on one GPU. **One process
leaves a discrete GPU 25–28% idle**; two or three fill it. The embeddings are
identical to Ollama's for the same GGUF (cosine similarity 1.00000). Every
configuration we measured, with GPU utilization and the traps we hit, is on
[llama-server vs Ollama: measured configurations](./llama-server-benchmarks).

## Setup

TeaRAGs never starts, installs or supervises llama-server. It prints the
commands, and you run them on the GPU host. The GPU host needs neither Node nor
TeaRAGs — only a llama-server build for its GPU (ROCm or Vulkan for AMD, Vulkan
for Intel, CUDA for NVIDIA, Metal on macOS) from the
[llama.cpp releases](https://github.com/ggml-org/llama.cpp/releases).

### 1. Print the commands for the GPU host

Run this on the machine where TeaRAGs runs. `--os` selects the GPU host's shell
and path syntax:

```bash
tea-rags llama-server command \
  --bin 'C:\llama\llama-server.exe' \
  --os windows \
  --device ROCm0 \
  --advertise 192.168.1.71 \
  --api-key <secret> \
  --autostart
```

| Flag          | Meaning                                                                                                              | Default                                       |
| ------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `--bin`       | Path of the llama-server binary **on the GPU host**. One build per run                                               | required                                      |
| `--os`        | `windows`, `linux` or `macos` — the GPU host's OS                                                                    | this machine's OS                             |
| `--device`    | Device id from `<bin> --list-devices`. Repeat it per GPU; each device gets its own port                              | none: one line without `--device`, plus a hint |
| `--host`      | Bind address                                                                                                         | `0.0.0.0`                                     |
| `--port`      | Port of the first device; the next device gets the next port                                                         | `8081`                                        |
| `--slots`     | Parallel slots per server (`-np`)                                                                                    | `4`                                           |
| `--model`     | GGUF path on the GPU host, or an Ollama model reference to download there                                            | `EMBEDDING_MODEL`, else the jina default      |
| `--advertise` | Address clients dial; goes into the printed `EMBEDDING_BASE_URL`                                                     | the bind address                              |
| `--api-key`   | Adds `--api-key` to every launch line and prints it as `EMBEDDING_API_KEY`                                           | none                                          |
| `--autostart` | Also print the start-at-boot registration                                                                            | off                                           |

The output is a numbered sheet, copy-paste ready for the target OS:

1. **Download the model** — the GGUF straight from the Ollama registry, then a
   sha256 check of the file (`Invoke-WebRequest` + `Get-FileHash` on Windows,
   `curl -L` + `sha256sum` / `shasum -a 256` elsewhere). TeaRAGs resolves the
   registry manifest itself, so the URL and digest are exact. Skipped when
   `--model` is a path.
2. **Launch llama-server**, one line per device:
   `<bin> -m <gguf> --embedding -ngl 999 -fa on -np 4 -c 32768 -b 8192 -ub 8192 --device <id> --host <host> --port <port>`.
   Without `--device` it prints one line and tells you to run
   `<bin> --list-devices`, pick ids, and re-run with `--device`.
3. **Open the firewall** for the port range (`netsh advfirewall` on Windows,
   `ufw` on Linux, a note for the macOS application firewall).
4. **Keep the host awake** (`powercfg` on Windows, `systemd-inhibit` on Linux,
   `caffeinate -s` on macOS). A sleeping GPU host fails the run.
5. **Start at boot** (with `--autostart`): on Windows a launcher `.cmd` per port
   next to the model plus a `schtasks /SC ONSTART /RL HIGHEST /RU SYSTEM` task;
   a systemd user unit on Linux; a launchd agent on macOS. On Windows, run the
   firewall, keep-awake and autostart steps in an **elevated PowerShell**.
6. **Client configuration** — the `EMBEDDING_*` lines for the TeaRAGs machine.

**Several instances per GPU.** `command` prints one instance per `--device`.
To run three instances on one GPU, run it three times with the same `--device`
and `--port 8081`, `8082`, `8083`, and start them **one after another** (wait
for each `/health`): two Vulkan instances starting at the same moment can fail
with `invalid device`. Keep `--slots 4`; `-np 3` and `-np 6` crashed the
Vulkan build we tested.

The printed `-c` is `slots × 8192`, which gives every slot an 8192-token window
— the same window TeaRAGs uses with Ollama for jina, so chunk sizes match. The
printed `-b`/`-ub 8192` let one slot take a full 8192-token input; see
[Troubleshooting](#input-too-large-to-process).

### 2. Configure TeaRAGs

```bash
export EMBEDDING_PROVIDER=llama-server
export EMBEDDING_BASE_URL=http://192.168.1.71:8081,8082,8083,8084
export EMBEDDING_API_KEY=<secret>        # only if the server has --api-key
export EMBEDDING_FALLBACK_URL=8080,8081  # optional: local llama-server, see below
```

Endpoint lists accept a shorthand for several servers on one host: a bare port
(`8082` or `:8082`) reuses the scheme and host of the URL before it, and a bare
port with no URL before it means `http://localhost`. So
`http://192.168.1.71:8081,8082` is two endpoints on that host, and `8080,8081`
is two on this machine. Full URLs still work.

### 3. Optional: a local fallback llama-server

The fallback is a llama-server **on your own machine** serving the same GGUF.
It is never Ollama: Ollama may not serve the model you picked for llama-server.

```bash
# Download the GGUF locally (sha256-verified); the last line is its path
tea-rags llama-server fetch-model

# Print the local launch line (and, with --autostart, a launchd agent)
tea-rags llama-server command --os macos --host 127.0.0.1 --port 8080 \
  --bin /opt/homebrew/bin/llama-server --model <path printed by fetch-model>
```

Put the printed URL into `EMBEDDING_FALLBACK_URL`, not `EMBEDDING_BASE_URL`.

`fetch-model [model]` takes any model from the Ollama library (default:
`EMBEDDING_MODEL`, else the jina default). It stores the file as
`<name>@<tag>-<12 hex digits of sha256>.gguf` under `~/.tea-rags/models/gguf`
(or `TEA_RAGS_DATA_DIR/models/gguf`; `--dir` overrides). The download is
verified against the registry digest before it is moved into place, and a file
already present with the right digest is not downloaded again.

## Configuration

| Variable                                        | Description                                                                                                                                                                    | Default                                            |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| `EMBEDDING_PROVIDER`                            | `llama-server`                                                                                                                                                                 | `ollama`                                           |
| `EMBEDDING_BASE_URL`                            | Comma-separated **peer** endpoints, one llama-server per GPU, all serving the same model                                                                                       | `http://localhost:8080`                            |
| `EMBEDDING_FALLBACK_URL`                        | Comma-separated **fallback** endpoints, used only while every peer has failed. A local llama-server, or another remote host                                                    | —                                                  |
| `EMBEDDING_API_KEY`                             | Sent as `Authorization: Bearer <key>` to every endpoint. Must match llama-server `--api-key`. Never written to the project registry                                              | —                                                  |
| `EMBEDDING_MODEL`                               | The model the servers are expected to serve. Used for the dimension lookup and the served-model check; llama-server embeds with whatever GGUF it loaded                        | `unclemusclez/jina-embeddings-v2-base-code:latest` |
| `EMBEDDING_DIMENSIONS`                          | Pin the vector width. Otherwise taken from the built-in model table, else measured with one probe embed                                                                        | Resolved                                           |
| `EMBEDDING_TUNE_BATCH_SIZE`                     | Ceiling for the texts per pipeline batch; one batch is fanned out across all endpoints and slots                                                                                | `256`                                              |
| `EMBEDDING_TUNE_FAILOVER_CONSECUTIVE_FAILURES`  | Consecutive failed requests after which an endpoint is taken out. A refused connection takes it out immediately                                                                | `3`                                                |
| `EMBEDDING_TUNE_UNAVAILABLE_RETRY_MAX_WAIT_MS`  | How long to wait, with backoff, when **no** endpoint is reachable before the index fails. `0` fails at once                                                                    | `240000`                                           |
| `EMBEDDING_TUNE_UNAVAILABLE_RETRY_BASE_DELAY_MS`| First backoff step of that wait; exponential, capped at 30s                                                                                                                    | `2000`                                             |

The batch size and the client-side embedding concurrency are then tuned during
the run — see [Adaptive Embedding](/config/performance-tuning#adaptive-embedding).
Leave `INGEST_PIPELINE_CONCURRENCY` unset: the climb then has an implicit
ceiling of 8, and an explicit value would become its hard cap.

## How it works

**Peers and fallbacks.** Every URL in `EMBEDDING_BASE_URL` is a peer; all peers
share the load. An endpoint is taken out after
`EMBEDDING_TUNE_FAILOVER_CONSECUTIVE_FAILURES` consecutive failures (timeout,
5xx unrelated to size, malformed response), or at once on a refused
connection. When every peer is out, the endpoints in `EMBEDDING_FALLBACK_URL`
take over. A background probe checks the failed endpoints' `/health` every 30
seconds and re-admits those that answer; once any peer is back, the fallbacks
are left. When no endpoint at all is reachable, the run waits up to
`EMBEDDING_TUNE_UNAVAILABLE_RETRY_MAX_WAIT_MS` for one to return instead of
aborting a long index.

**Fan-out.** One pipeline batch is shared by the healthy endpoints of the
active tier through work stealing:

1. The batch is cut into contiguous **micro-batches** of about equal
   **character** size, four per parallel slot across the active endpoints
   (never more micro-batches than texts). They go onto one shared queue.
2. Every endpoint runs as many workers as the server has slots
   (`total_slots` from its `/props`, `-np`). Each worker takes the next
   micro-batch off the queue, embeds it, and comes back for another until the
   queue is empty. This keeps every slot busy without raising the pipeline's
   own concurrency.
3. A fast GPU therefore takes more micro-batches and a slow one fewer, with no
   speed estimate involved. Uneven GPUs — an RX 7800M next to an Arc iGPU — are
   balanced without configuration, and the end of a batch waits for at most
   one micro-batch on the slowest endpoint rather than its whole share.
4. If an endpoint fails mid-batch, its micro-batch goes back to the front of
   the queue and that endpoint stops taking work; the endpoints still standing
   finish the batch in the same call. Results are reassembled in input order.

A batch of 256 across two GPUs at `-np 4` becomes 32 micro-batches of 8 texts,
eight in flight at a time.

Each endpoint's measured throughput in characters per second (an exponential
moving average, α = 0.3) is still recorded per request; it feeds the metrics
and the batch-size tuner, not the split.

The earlier split assigned each endpoint a share proportional to that estimate
up front. It was only as good as the estimate: in a measured run the Arc iGPU
received 14% of the tokens against a capacity share of about 12%, the faster
instances idled at the end of each batch, and end-to-end throughput was about
80% of the synthetic benchmark. Work stealing replaces it.

**Context window.** The context length TeaRAGs works with is the per-slot
`n_ctx` the server reports in `/props`, and it determines the derived chunk
size. The printed `-c <slots × 8192>` yields 8192 per slot, so jina chunks are
the same as with Ollama. Another `-c` or `-np` changes the per-slot window,
therefore the chunk size and the chunk set: a project indexed under one shape
needs a `--force` reindex after switching to another.

**Served-model check.** At first contact with each endpoint, peers and fallback
alike, TeaRAGs compares the GGUF file name in its `/props` with
`EMBEDDING_MODEL`. An endpoint whose file does not look like the configured
model gets no embedding requests for the rest of the run, and TeaRAGs logs once
which file it serves, naming `tea-rags llama-server fetch-model` and
`tea-rags llama-server command` as the fix. This matters because a peer serving
another model of the same width returns vectors the collection's embedding model
guard cannot tell apart. When no endpoint serving the configured model is left,
indexing fails at once with `INFRA_LLAMA_SERVER_MODEL_MISMATCH`, listing each
endpoint and the file it serves; it does not wait for an endpoint to come back.
A GGUF renamed to carry the model name or its digest, a content-addressed
`sha256-…` blob, and a server whose `/props` names no file are all accepted.

## Troubleshooting

### Every embed fails with HTTP 401

`/health` is public, but `/props` and `/v1/embeddings` require the key of a
server started with `--api-key`. Without `EMBEDDING_API_KEY` the health check
passes, the slot count falls back to 1, and embeds fail with a hint to set
`EMBEDDING_API_KEY`. Set it to the server's `--api-key`.

### Input too large to process

```
input (N tokens) is too large to process. increase the physical batch size
```

llama-server answers HTTP 500 with this when one input does not fit its
physical batch. Launch with `-b` and `-ub` at least the model's context (8192
for jina) — the printed launch lines do. TeaRAGs treats it as a size failure:
the request is retried in halves, and a single chunk that still does not fit is
quarantined (its file is recorded and skipped) instead of failing the run.

### Windows: Smart App Control blocks llama-server

The llama.cpp release builds are unsigned. With Smart App Control on, Windows
refuses to run them (error `C0E90002`). `Unblock-File` does not help. The only
fix is to turn Smart App Control off in Windows Security, and turning it off
is **irreversible**. Decide before you do it; a Linux host avoids the question.

### ROCm build fails to start: `hipblas.dll` / `rocblas.dll` missing

Some ROCm builds of llama-server for Windows ship without the HIP BLAS
runtime. If Ollama is installed on the same host, its ROCm runtime completes
the build: from Ollama's `lib/ollama/rocm` directory, copy `libhipblas.dll` as
`hipblas.dll`, plus `rocblas.dll` and the `rocblas/` kernels folder, next to
`llama-server.exe`. A Vulkan build needs none of this and was 15–25% faster on
the RX 7800M in our measurement.

### The run stops after the host went idle

A GPU host that sleeps drops every request. Run the printed keep-awake step
(`powercfg /change standby-timeout-ac 0`, `systemd-inhibit`, `caffeinate -s`).
The recovery wait covers a short outage; a host asleep for longer than
`EMBEDDING_TUNE_UNAVAILABLE_RETRY_MAX_WAIT_MS` fails the run.

### Throughput collapses when llama-server runs as a service

A llama-server writes an INFO line per slot per request. Redirected to a file
by a service wrapper, that logging throttled each instance about 6× in our
setup (54 instead of 379 texts/s) and kept the SSD at 100%. Add
`--log-disable` to service launch lines, or do not redirect the output to a
file. Add `--metrics` if you want per-server counters at `/metrics`.

### Throughput collapses after many test runs

On Windows, closing an SSH session does not stop a llama-server started through
it. Orphaned instances hold VRAM, and new ones spill into system memory. Check
`Get-Process llama-server` and stop leftovers before measuring.

### Connection refused or timeout from the client

Check that llama-server binds `0.0.0.0` (not `127.0.0.1`), that the printed
firewall rule was applied, and that `EMBEDDING_BASE_URL` uses the host's LAN
address (`--advertise`), not the bind address. `curl http://<host>:<port>/health`
from the client should return `{"status":"ok"}`.
