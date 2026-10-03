---
title: llama-server
sidebar_position: 3
---

# llama-server

Embedding provider for a standalone
[llama.cpp `llama-server`](https://github.com/ggml-org/llama.cpp/tree/master/tools/server),
usually one instance per GPU on a dedicated GPU host in your network. TeaRAGs
spreads every embedding batch across all instances and all of their parallel
slots, and falls back to a llama-server on your own machine when the GPU host
is gone.

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
slots, driven by a client that keeps every slot busy, is roughly twice as fast
on the same hardware. Measured on a mini-PC host (1024 chunks of a production
codebase, `jina-embeddings-v2-base-code`, `/v1/embeddings`):

| Server                                      | texts/s | vs Ollama |
| ------------------------------------------- | ------- | --------- |
| Ollama 0.35 (batch 64, concurrency 2)       | 99      | 1.00×     |
| llama-server ROCm, RX 7800M, `-np 4`        | 191     | 1.92×     |
| llama-server ROCm, RX 7800M, `-np 8`        | 152–171 | 1.5–1.7×  |
| llama-server Vulkan, RX 7800M, `-np 4 -fa on` | 218   | 2.20×     |
| llama-server Vulkan, Arc 140T iGPU, `-np 4` | 48      | 0.48×     |

`-np 4` is the measured optimum; `-np 8` is slower. On an Apple M3 Pro,
llama-server with `-np 2..4` gave 14–17% over `-np 1`. Its embeddings are
identical to Ollama's for the same GGUF (cosine similarity 1.00000).

A combined run over two GPUs of one host has not been measured yet; see the
[multi-GPU guide](./llama-server-multi-gpu) for how such a setup is wired.

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

The printed `-c` is `slots × 8192`, which gives every slot an 8192-token window
— the same window TeaRAGs uses with Ollama for jina, so chunk sizes match. The
printed `-b`/`-ub 8192` let one slot take a full 8192-token input; see
[Troubleshooting](#input-too-large-to-process).

### 2. Configure TeaRAGs

```bash
export EMBEDDING_PROVIDER=llama-server
export EMBEDDING_BASE_URL=http://192.168.1.71:8081
export EMBEDDING_API_KEY=<secret>                    # only if the server has --api-key
export EMBEDDING_FALLBACK_URL=http://127.0.0.1:8080   # optional, see below
```

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

**Fan-out.** One pipeline batch is split across the healthy endpoints of the
active tier:

1. Each endpoint is weighted by its measured throughput in characters per
   second (an exponential moving average, α = 0.3, updated by every request).
   An endpoint not measured yet gets the mean of the measured ones.
2. Texts are assigned contiguously by **character** share, so a fast GPU gets
   proportionally more input and every endpoint finishes at about the same
   time. Uneven GPUs — an RX 7800M next to an Arc iGPU — are balanced this way
   without configuration.
3. Each endpoint's share is cut again into as many parallel requests as the
   server has slots (`total_slots` from its `/props`, `-np`). This keeps every
   slot busy without raising the pipeline's own concurrency.
4. If an endpoint fails mid-batch, its texts are re-split across the endpoints
   still standing in the same call. Results are reassembled in input order.

A batch of 256 across two GPUs at `-np 4` becomes 8 parallel requests of about
32 texts.

**Context window.** The context length TeaRAGs works with is the per-slot
`n_ctx` the server reports in `/props`, and it determines the derived chunk
size. The printed `-c <slots × 8192>` yields 8192 per slot, so jina chunks are
the same as with Ollama. Another `-c` or `-np` changes the per-slot window,
therefore the chunk size and the chunk set: a project indexed under one shape
needs a `--force` reindex after switching to another.

**Served-model check.** At first contact TeaRAGs compares the GGUF file name in
`/props` with `EMBEDDING_MODEL` and logs a warning when they do not look alike,
naming `tea-rags llama-server fetch-model` and `tea-rags llama-server command`
as the fix. It only warns: a renamed GGUF of the same model is legitimate, and a
real vector-width mismatch is caught by the embedding model guard of the
collection.

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
`llama-server.exe`. A Vulkan build needs none of this and was faster on the
RX 7800M in our measurement.

### The run stops after the host went idle

A GPU host that sleeps drops every request. Run the printed keep-awake step
(`powercfg /change standby-timeout-ac 0`, `systemd-inhibit`, `caffeinate -s`).
The recovery wait covers a short outage; a host asleep for longer than
`EMBEDDING_TUNE_UNAVAILABLE_RETRY_MAX_WAIT_MS` fails the run.

### Connection refused or timeout from the client

Check that llama-server binds `0.0.0.0` (not `127.0.0.1`), that the printed
firewall rule was applied, and that `EMBEDDING_BASE_URL` uses the host's LAN
address (`--advertise`), not the bind address. `curl http://<host>:<port>/health`
from the client should return `{"status":"ok"}`.
