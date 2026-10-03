---
title: llama-server on several GPUs
sidebar_position: 4
---

import MermaidTeaRAGs from '@site/src/components/MermaidTeaRAGs';

# llama-server on several GPUs

One llama-server instance serves one GPU. A host with two GPUs runs two
instances on two ports, and TeaRAGs treats them as peers: every embedding batch
is split between them by measured speed. This guide walks through a real host —
a Windows mini-PC with an AMD RX 7800M eGPU and an Intel Arc 140T iGPU — with a
Mac running TeaRAGs and a local fallback. Read the
[llama-server provider page](./llama-server) first.

<MermaidTeaRAGs>
{`
flowchart LR
    subgraph mac["💻 Mac — TeaRAGs"]
        TeaRAGs[🍵 TeaRAGs<br/><small>fan-out by measured speed</small>]
        Local[✨ llama-server :8080<br/><small>fallback · Metal</small>]
    end

    subgraph host["🖥️ GPU host — Windows"]
        RX[✨ llama-server :8081<br/><small>RX 7800M · ROCm or Vulkan</small>]
        Arc[✨ llama-server :8082<br/><small>Arc 140T · Vulkan</small>]
    end

    TeaRAGs -->|peer| RX
    TeaRAGs -->|peer| Arc
    TeaRAGs -.->|all peers down| Local
`}
</MermaidTeaRAGs>

## Why one command per build

Different GPUs often need different llama-server builds: ROCm for an AMD card,
Vulkan for an Intel iGPU, CUDA for NVIDIA. `tea-rags llama-server command`
prints the lines for **one** binary, so you run it once per build and join the
endpoint lists. If one build sees every GPU (a Vulkan build usually sees both
the AMD and the Intel device), one run with `--device` repeated is enough.

Device ids below (`ROCm0`, `Vulkan1`) are examples. Take yours from
`<bin> --list-devices` on the host.

## 1. RX 7800M — ROCm build, port 8081

```bash
tea-rags llama-server command --os windows \
  --bin 'C:\llama-rocm\llama-server.exe' \
  --device ROCm0 --port 8081 \
  --advertise 192.168.1.71 --api-key <secret> --autostart
```

In our measurement the Vulkan build was faster on this card than the ROCm one
(218 vs 191 texts/s at `-np 4`), so `--bin` may just as well point at the Vulkan
build with the RX 7800M's Vulkan device id.

## 2. Arc 140T — Vulkan build, port 8082

```bash
tea-rags llama-server command --os windows \
  --bin 'C:\llama-vulkan\llama-server.exe' \
  --device Vulkan1 --port 8082 \
  --advertise 192.168.1.71 --api-key <secret> --autostart
```

Use a `--port` past the first run's range so the two instances do not collide.
Run each printed sheet on the host: model download, launch line, firewall,
keep-awake, autostart. Both runs print the same model path when `--model` is the
same, so the second sheet's download step can be skipped once the first one's
hash check printed `True`.

Keep `--slots` and the printed `-c` as they are on every peer. TeaRAGs derives
the chunk size from the per-slot context window (`-c` / `-np` = 8192), so peers
with different per-slot windows would disagree about chunk size.

## 3. Join the endpoint lists on the client

Each run ends with its own `EMBEDDING_BASE_URL`. Join them with a comma:

```bash
export EMBEDDING_PROVIDER=llama-server
export EMBEDDING_BASE_URL=http://192.168.1.71:8081,http://192.168.1.71:8082
export EMBEDDING_API_KEY=<secret>
```

## 4. Local fallback on the Mac

```bash
tea-rags llama-server fetch-model
tea-rags llama-server command --os macos --host 127.0.0.1 --port 8080 \
  --bin /opt/homebrew/bin/llama-server --model <path printed by fetch-model> --autostart

export EMBEDDING_FALLBACK_URL=http://127.0.0.1:8080
```

The fallback serves only while both peers are out. A probe re-checks the peers
every 30 seconds and returns to them as soon as one answers.

## How uneven GPUs share a batch

The two cards are far apart: alone, the RX 7800M ran at 191–218 texts/s and the
Arc 140T at 48. TeaRAGs does not need to know that in advance. Each endpoint
carries a moving average of its measured characters per second, and each batch
is split by **character** share in proportion to it, so the slower GPU gets a
smaller slice and both finish at about the same time. Until an endpoint has
been measured it gets the mean weight of the measured ones; the first few
batches settle the split. Each endpoint's slice is then cut into one request
per slot (`-np`), read from the server's `/props`.

When one instance fails mid-batch, its texts move to the other in the same call;
the run continues on one GPU, and the failed instance rejoins after its
`/health` probe succeeds.

The combined throughput of both GPUs together has **not been measured yet**.
Do not assume it is the sum of the single-GPU numbers; measure on your own host
before relying on it.

## Verify

```bash
curl http://192.168.1.71:8081/health
curl http://192.168.1.71:8082/health
DEBUG=1 tea-rags index-codebase --project <alias> --wait-enrichments --json
```

With `DEBUG=1`, `~/.tea-rags/logs/pipeline-*.log` shows the batch size and
concurrency the tuner settled on (`EMBED_TUNE_ADAPTED` lines).
