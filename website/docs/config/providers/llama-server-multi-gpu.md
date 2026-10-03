---
title: llama-server on several GPUs
sidebar_position: 4
---

import MermaidTeaRAGs from '@site/src/components/MermaidTeaRAGs';

# llama-server on several GPUs

A host with several GPUs runs several llama-server instances, each on its own
port, and TeaRAGs treats all of them as peers: every embedding batch is split
between them by measured speed. One instance per GPU is not enough — a single
llama-server process leaves a discrete GPU 25–28% idle — so a fast GPU gets
two or three instances of its own.

This guide walks through a real host — a Windows mini-PC with an AMD RX 7800M
eGPU and an Intel Arc 140T iGPU — with a Mac running TeaRAGs and a local
fallback. Read the [llama-server provider page](./llama-server) first; the
numbers behind every choice here are on
[measured configurations](./llama-server-benchmarks).

<MermaidTeaRAGs>
{`
flowchart LR
    subgraph mac["💻 Mac — TeaRAGs"]
        TeaRAGs[🍵 TeaRAGs<br/><small>fan-out by measured speed</small>]
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

## The measured layout

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

## 1. Print the commands

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

## 2. Start the instances one at a time

Two Vulkan instances that start at the same moment race the device enumeration,
and one of them can fail with `invalid device: Vulkan1`. Start each instance
only after the previous one answers `/health`. For start at boot, use one
supervisor that launches the instances in sequence rather than one scheduled
task per port. A supervisor should also:

- pass `--log-disable` — per-request log lines redirected to a file throttled
  every instance about 6× and kept the SSD at 100%;
- restart an instance that exits;
- keep the host awake while it runs.

## 3. Configure the client

```bash
export EMBEDDING_PROVIDER=llama-server
export EMBEDDING_BASE_URL=http://192.168.1.71:8081,8082,8083,8084
```

A bare port reuses the host of the URL before it, so one host with four ports
fits on one line.

## 4. Local fallback on the Mac

```bash
tea-rags llama-server fetch-model
for port in 8080 8081; do
  tea-rags llama-server command --os macos --host 127.0.0.1 --port $port \
    --bin /opt/homebrew/bin/llama-server --model <path printed by fetch-model> --autostart
done

export EMBEDDING_FALLBACK_URL=8080,8081
```

Two instances are the optimum on Apple Silicon: 93.5 texts/s on an M3 Pro,
1.7× Ollama on the same Mac. A bare port with no host means `http://localhost`.
The fallback serves only while every peer is out. A probe re-checks the peers
every 30 seconds and returns to them as soon as one answers.

## How uneven GPUs share a batch

TeaRAGs does not need to know how fast each instance is. Each endpoint carries a
moving average of its measured characters per second, and each batch is split
by **character** share in proportion to it, so the Arc instance gets a smaller
slice than each RX instance. Until an endpoint has been measured it gets the
mean weight of the measured ones; the first few batches settle the split. Each
endpoint's slice is then cut into one request per slot (`-np`), read from the
server's `/props`.

In a real index of 41,626 chunks the split came out at 28–29% per RX instance
and 14% for the Arc (its capacity share is about 12%), and the run reached 193
chunks/s end to end.

When one instance fails mid-batch, its texts move to the others in the same
call; the failed instance rejoins after its `/health` probe succeeds.

## Verify

```bash
curl http://192.168.1.71:8081/health   # repeat per port
DEBUG=1 tea-rags index-codebase --project <alias> --wait-enrichments --json
```

The JSON result's `infraHealth.embedding` lists every endpoint and the batch
size and concurrency the tuner settled on. With `--metrics` on the servers,
`curl http://<host>:<port>/metrics` shows each instance's token counters, which
is how to see the split between them.
