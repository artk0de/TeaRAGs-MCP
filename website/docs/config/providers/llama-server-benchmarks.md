---
title: llama-server vs Ollama — measured configurations
sidebar_position: 4.5
---

# llama-server vs Ollama: measured configurations

This page records every configuration we measured while moving a 3M-line
project from Ollama to llama-server, on two machines:

- **GPU host:** a Windows 11 mini-PC (Intel Core Ultra 9 285H) with an AMD
  Radeon RX 7800M eGPU (12 GB) and an Intel Arc 140T iGPU.
- **Workstation:** an Apple M3 Pro MacBook, which runs TeaRAGs and the local
  fallback.

The short version:

- **One llama-server process does not saturate a discrete GPU.** It peaks at
  72–75% utilization. Run **several instances per GPU** and list them all as
  peers.
- On the RX 7800M, the **Vulkan build beats ROCm** by 15–25% at every
  instance count, though ROCm runs noticeably quieter.
- The best layout on the GPU host — **three Vulkan instances on the RX 7800M
  plus one on the Arc iGPU** — reaches **334 texts/s, 3.4× Ollama** on the
  same host (387 texts/s with the GPU's power boost on).
- On the Mac, two llama-server instances run **1.7× faster than Ollama**,
  which makes llama-server the better local fallback too.

## Method

- **Model:** `unclemusclez/jina-embeddings-v2-base-code:latest`, the same
  F16 GGUF for Ollama and llama-server (llama-server read the file straight from
  Ollama's blob store, or from `tea-rags llama-server fetch-model`).
- **Input:** 1024 chunks of the production codebase, 687k characters (about
  670 characters and 190 tokens per chunk), cycled for 40–60 seconds.
- **Client:** batches of 64 texts to `/v1/embeddings`, with 4 requests in
  flight per server. Each server gets its own queue, so a slow GPU never stalls
  a fast one.
- **Server flags**, unless a row says otherwise:
  `--embedding -ngl 999 -np 4 -c 32768 -b 8192 -ub 8192 -fa on`. That is
  4 slots of 8192 tokens each, the same context TeaRAGs uses with Ollama, so
  chunk sizes match.
- **GPU utilization:** the Windows `GPU Engine` counters, averaged over the
  run, for the compute engine of each adapter.
- **Ollama:** version 0.35 on the GPU host, batch 64 with concurrency 2, which
  is the setting a TeaRAGs index uses. Ollama runs embedding models through its
  own llama-server with a single slot, so more concurrency does not help it.

:::warning Measuring with llama-server
Two traps invalidated our first round of numbers:

- **Closing the SSH session does not stop a llama-server started through it**
  on Windows. Thirty orphaned instances filled the VRAM and RAM, and every
  later run spilled into system memory and collapsed. Check
  `Get-Process llama-server` before each run.
- **Starting two Vulkan instances at the same moment** can fail one of them
  with `invalid device: Vulkan1`. Start instances one after another, waiting
  for `/health`.
:::

## GPU host: single GPU

| Configuration (RX 7800M) | texts/s | vs Ollama | GPU utilization |
| --- | --- | --- | --- |
| Ollama 0.35 | 99 | 1.00× | — |
| llama-server ROCm ×1 | 189 | 1.91× | 75% |
| llama-server ROCm ×2 | 225 | 2.27× | 93% |
| llama-server Vulkan ×1 | 214 | 2.16× | 72% |
| llama-server Vulkan ×2 | 281 | 2.84× | 100% |
| **llama-server Vulkan ×3** | **307** | **3.10×** | **100%** |

`×N` is the number of llama-server instances on the same GPU, each on its own
port with `-np 4`. A single instance leaves a quarter of the GPU idle between
its passes; a second instance fills those gaps.

The Arc 140T iGPU alone does 47.5 texts/s at 91% utilization. A second instance
on it adds nothing (48 texts/s), because one instance already keeps it busy.

### Server flags (Vulkan ×1, RX 7800M)

| Flags | texts/s |
| --- | --- |
| `-np 4 -fa on -ub 8192` | 207 |
| `-np 4 -fa on -ub 4096` | 208 |
| `-np 2 -fa on` | 175 |
| `-np 4 -fa off` | 177 |
| `-np 3` or `-np 6` | **crashes at load** (`GGML_ASSERT(ggml_can_mul_mat(a, b))`) |

Keep `-np 4` and `-fa on`; `-ub` 4096 and 8192 are equal. `-np 3` and
`-np 6` crashed this Vulkan build at load, so stay on 2, 4 or 8.

## GPU host: both GPUs

| Configuration | texts/s | vs Ollama | RX / Arc utilization |
| --- | --- | --- | --- |
| RX ROCm ×1 + Arc Vulkan ×1 | 220 | 2.22× | 74% / 94% |
| RX ROCm ×2 + Arc Vulkan ×1 | 254 | 2.57× | 93% / 95% |
| RX Vulkan ×2 + Arc Vulkan ×1 | 304 | 3.07× | 100% / 94% |
| **RX Vulkan ×3 + Arc Vulkan ×1** | **334** | **3.37×** | **100% / 93%** |

Adding the Arc iGPU costs the RX a few percent (it shares the host's memory
controller and CPU), but the total still rises by about 27 texts/s. AMD and
Intel Vulkan drivers run side by side without trouble once the instances start
one at a time.

### With the GPU power boost

The mini-PC has a hardware switch that raises the eGPU's power limit:

| Configuration | Normal | Boost |
| --- | --- | --- |
| RX Vulkan ×3 + Arc Vulkan ×1 | 334 | **387** (3.9×) |
| RX ROCm ×3 | — | 286 |
| RX ROCm ×3 + Arc Vulkan ×1 | — | 318 |

Vulkan stays ahead of ROCm with the boost on.

## Workstation: Mac fallback

Apple M3 Pro, Metal, homebrew `llama.cpp` 0.5.0, the same model and input:

| Configuration | texts/s | vs Ollama |
| --- | --- | --- |
| Ollama 0.11.7 (concurrency 2 or 4) | 55–56 | 1.00× |
| llama-server ×1 | 82 | 1.48× |
| **llama-server ×2** | **93.5** | **1.69×** |
| llama-server ×3 | 92 | 1.66× |

Two instances are the optimum on Apple Silicon; a third adds nothing.

## A real index

A full `--force` reindex of the TeaRAGs repository itself (3741 files, 41,626
chunks) through the four-instance GPU-host layout over the LAN:

| Phase | Duration |
| --- | --- |
| Embedding | 215 s (193 chunks/s end to end) |
| Enrichment (git, codegraph) | 14 s |
| Total | 230 s |

The tuner settled on batch 256 and client concurrency 8. Per-server token
counters (`--metrics`) showed the batch split by measured speed: 28–29% to
each RX instance and 14% to the Arc, against an Arc capacity share of about
12%. The Arc's slice is slightly too large while the speed estimates settle,
so the RX instances idle briefly at the end of each batch; end-to-end
throughput is about 80% of the synthetic figure.

## Recommended layouts

| Host | Layout | Expected |
| --- | --- | --- |
| Discrete AMD GPU (12 GB) | 3 Vulkan instances, `-np 4` | ~3× Ollama |
| Discrete + integrated GPU | 3 instances on the discrete GPU + 1 on the iGPU | ~3.4× Ollama |
| Apple Silicon (fallback) | 2 instances, `-np 4` | ~1.7× Ollama |

See the [multi-GPU guide](./llama-server-multi-gpu) for how to set such a
layout up, and the [provider page](./llama-server) for the client
configuration.
