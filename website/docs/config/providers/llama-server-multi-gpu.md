---
title: Running llama-server as several processes
sidebar_position: 4
---

import MermaidTeaRAGs from '@site/src/components/MermaidTeaRAGs';

# Running llama-server as several processes

One llama-server process does not keep a GPU busy: it leaves a discrete GPU
25–28% idle. Run several instances, each on its own port, and TeaRAGs treats all
of them as peers: every embedding batch is shared between them by work
stealing. That holds on every kind of host:

- [one GPU, several processes](#one-gpu-several-processes) — two or three
  instances on one discrete GPU;
- [several GPUs](#several-gpus) — instances on every GPU of a host;
- [Apple Silicon](#apple-silicon-one-mac-two-instances) — two instances even on
  a single Mac;
- [several models on one host](#several-models-on-one-host) — one group of
  instances per model.

This guide walks through a real setup — a Windows mini-PC with an AMD RX 7800M
eGPU and an Intel Arc 140T iGPU, with a Mac running TeaRAGs and a local
fallback. Read the [llama-server provider page](./llama-server) first; the
numbers behind every choice here are on
[measured configurations](./llama-server-benchmarks).

<MermaidTeaRAGs>
{`
flowchart LR
    subgraph mac["💻 Mac — TeaRAGs"]
        TeaRAGs[🍵 TeaRAGs<br/><small>work stealing over micro-batches</small>]
        Local[✨ llama-server :8080 · :8081<br/><small>fallback · Metal</small>]
    end

    subgraph host["🖥️ GPU host — Windows"]
        RX[✨ llama-server :8081 · :8082 · :8083<br/><small>RX 7800M · Vulkan</small>]
        Arc[✨ llama-server :8084<br/><small>Arc 140T · Vulkan</small>]
    end

    TeaRAGs -->|peers| RX
    TeaRAGs -->|peer| Arc
    TeaRAGs -.->|all peers down| Local
`}
</MermaidTeaRAGs>

## One GPU, several processes

Measured on the RX 7800M alone, Vulkan, `-np 4`:

| Instances | texts/s | vs Ollama |
| --- | --- | --- |
| Ollama 0.35 | 99 | 1.00× |
| llama-server ×1 | 214 | 2.16× |
| llama-server ×3 | 307 | 3.10× |

Three instances saturate the discrete GPU (100%). An integrated GPU is filled
by one: the Arc 140T reaches 91% with one instance, and a second adds nothing.
Keep `--slots 4` on every instance; `-np 3` and `-np 6` crashed the Vulkan
build we tested.

## Several GPUs

### The measured layout

| Port | Device | Why |
| --- | --- | --- |
| 8081, 8082, 8083 | `Vulkan0` — RX 7800M | Three instances saturate the discrete GPU (100%) |
| 8084 | `Vulkan1` — Arc 140T | One instance already keeps the iGPU at 91%; a second adds nothing |

Every instance uses `-np 4 -c 32768 -b 8192 -ub 8192 -fa on`. Measured
throughput: 334 texts/s, 3.4× Ollama on the same host (387 with the GPU's
power boost).

**Vulkan, not ROCm, on the RX 7800M.** The Vulkan build was 15–25% faster at
every instance count. One Vulkan build also sees both GPUs, so a single binary
serves the whole host. ROCm is quieter; pick it if fan noise matters more than
the last 25%.

### 1. Print the commands

`tea-rags llama-server command` prints one instance per `--device`. For several
instances on one GPU, run it once per instance with the same `--device` and
the next `--port`:

```bash
for port in 8081 8082 8083; do
  tea-rags llama-server command --os windows \
    --bin 'C:\llama-vulkan\llama-server.exe' \
    --device Vulkan0 --port $port --advertise 192.168.1.71 --autostart
done
tea-rags llama-server command --os windows \
  --bin 'C:\llama-vulkan\llama-server.exe' \
  --device Vulkan1 --port 8084 --advertise 192.168.1.71 --autostart
```

Device ids (`Vulkan0`, `Vulkan1`) are examples; take yours from
`<bin> --list-devices` on the host. All runs print the same model path, so the
download step is needed only once.

Keep `--slots` and the printed `-c` the same on every peer. TeaRAGs derives the
chunk size from the per-slot context window (`-c` / `-np` = 8192), so peers with
different per-slot windows would disagree about chunk size.

### 2. Start the instances one at a time

Two Vulkan instances that start at the same moment race the device enumeration,
and one of them can fail with `invalid device: Vulkan1`. Start each instance
only after the previous one answers `/health`. For start at boot, use one
supervisor that launches the instances in sequence rather than one scheduled
task per port. A supervisor should also:

- pass `--log-disable` — per-request log lines redirected to a file throttled
  every instance about 6× and kept the SSD at 100%;
- restart an instance that exits;
- keep the host awake while it runs.

### 3. Configure the client

```bash
export EMBEDDING_PROVIDER=llama-server
export EMBEDDING_BASE_URL=http://192.168.1.71:8081,8082,8083,8084
```

A bare port reuses the host of the URL before it, so one host with four ports
fits on one line.

## Apple Silicon: one Mac, two instances

A single Mac also embeds faster with two llama-server instances than with one.
Measured on an Apple M3 Pro, Metal, homebrew `llama.cpp`:

| Configuration | texts/s | vs Ollama |
| --- | --- | --- |
| Ollama (concurrency 2 or 4) | 55–56 | 1.00× |
| llama-server ×1 | 82 | 1.48× |
| **llama-server ×2** | **93.5** | **1.69×** |
| llama-server ×3 | 92 | 1.66× |

Two instances are the optimum: 1.7× Ollama on the same Mac. A third adds
nothing. The same layout serves a Mac as its own embedding host or as the local
fallback for a GPU host:

```bash
tea-rags llama-server fetch-model
for port in 8080 8081; do
  tea-rags llama-server command --os macos --host 127.0.0.1 --port $port \
    --bin /opt/homebrew/bin/llama-server --model <path printed by fetch-model> --autostart
done
```

Start the second instance after the first answers `/health`. Then either use
the pair as the only endpoints:

```bash
export EMBEDDING_PROVIDER=llama-server
export EMBEDDING_BASE_URL=8080,8081
```

or as the fallback behind the GPU host:

```bash
export EMBEDDING_FALLBACK_URL=8080,8081
```

A bare port with no host means `http://localhost`. The fallback serves only
while every peer is out. A probe re-checks the peers every 30 seconds and
returns to them as soon as one answers.

## Several models on one host

A llama-server process serves the one GGUF it loaded. To serve two models from
one host, run a separate group of instances per model, each group on its own
port range — for example CodeRankEmbed on 8081–8084 and Muninn-small on
8091–8094:

```bash
# CodeRankEmbed group: 2048-token context, four slots
for port in 8081 8082 8083 8084; do
  tea-rags llama-server command --os windows \
    --bin 'C:\llama-vulkan\llama-server.exe' --device Vulkan0 --port $port \
    --model 'C:\models\CodeRankEmbed-Q8_0.gguf' --advertise 192.168.1.71
done
# Muninn-small group
for port in 8091 8092 8093 8094; do
  tea-rags llama-server command --os windows \
    --bin 'C:\llama-vulkan\llama-server.exe' --device Vulkan0 --port $port \
    --model 'C:\models\Muninn-small-f16.gguf' --advertise 192.168.1.71
done
```

- **Launch flags per model.** The printed launch line has
  `-c 32768 -b 8192 -ub 8192`, sized for an 8192-token context. For
  CodeRankEmbed change it to `-c 8192 -b 2048 -ub 2048`; Muninn-small takes it
  as printed. See [Embedding model choice](/config/embedding-model-choice).
- **Firewall per range.** Each `command` run prints a firewall rule for the
  ports of that run; apply the rules of both groups.
- **Fallback per model.** A fallback must serve the same GGUF as the peers it
  stands in for, so each model needs its own local fallback group.
- **VRAM.** Both groups share the GPU. These two models are small (146 MB and
  97 MB GGUFs); we have not measured the throughput of two groups busy at the
  same time.

Each TeaRAGs configuration points at one group:

```bash
# Projects indexed with CodeRankEmbed
export EMBEDDING_MODEL=nomic-ai/CodeRankEmbed
export EMBEDDING_BASE_URL=http://192.168.1.71:8081,8082,8083,8084

# Projects indexed with Muninn-small
export EMBEDDING_MODEL=brokkai/Muninn-small
export EMBEDDING_BASE_URL=http://192.168.1.71:8091,8092,8093,8094
```

The [served-model check](./llama-server#how-it-works) retires an endpoint whose
GGUF does not look like `EMBEDDING_MODEL`, so a URL list that points at the
wrong group fails with `INFRA_LLAMA_SERVER_MODEL_MISMATCH` instead of embedding
with the wrong model. Search embeds queries with the MCP server's
`EMBEDDING_MODEL`, so today one MCP server configuration serves projects of one
model.

## How uneven instances share a batch

TeaRAGs does not need to know how fast each instance is. Each batch is cut into
micro-batches of about equal **character** size, four per slot, on one shared
queue. Every instance runs one worker per slot (`-np`, read from the server's
`/props`), and each worker pulls the next micro-batch as soon as it finishes
the last one. The Arc instance therefore takes fewer micro-batches than each RX
instance, and the end of a batch waits for at most one micro-batch on the Arc.

Before work stealing, each batch was split up front by a moving average of
every instance's characters per second. In a real index of 41,626 chunks that
split came out at 28–29% per RX instance and 14% for the Arc (its capacity
share is about 12%), so the RX instances idled at the end of each batch; the
run reached 193 chunks/s end to end.

When one instance fails mid-batch, its micro-batch goes back to the front of
the queue for the others in the same call; the failed instance rejoins after
its `/health` probe succeeds.

## Verify

```bash
curl http://192.168.1.71:8081/health   # repeat per port
DEBUG=1 tea-rags index-codebase --project <alias> --wait-enrichments --json
```

The JSON result's `infraHealth.embedding` lists every endpoint and the batch
size and concurrency the tuner settled on. With `--metrics` on the servers,
`curl http://<host>:<port>/metrics` shows each instance's token counters, which
is how to see the split between them.
