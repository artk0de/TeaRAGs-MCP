---
title: ONNX
sidebar_position: 1
---

# ONNX (Built-in)

Local embedding provider using ONNX Runtime via `@huggingface/transformers`. Zero external dependencies — no services to install, no API keys.

| | |
|---|---|
| **Type** | Local |
| **Price** | 🟢 Free |
| **Scale*** | ~700k LoC |
| **Default model** | `jinaai/jina-embeddings-v2-base-code-fp16` |
| **Dimensions** | 768 |
| **URL** | — (built-in, no external service) |

> \* Estimated lines of code for initial full indexing within 45 minutes. Benchmarked on Apple M3 Pro with WebGPU — actual throughput depends on your hardware (GPU, memory bandwidth, device type).

## Key Features

- **Zero config** — just set `EMBEDDING_PROVIDER=onnx` and go
- **No external services** — runs inside the Node.js process via a daemon
- **WebGPU acceleration** — auto-detects Metal (macOS), D3D12 (Windows), Vulkan (Linux)
- **CPU fallback** — works everywhere, even without a GPU
- **HuggingFace models** — any ONNX-compatible model from HuggingFace Hub
- **Persistent daemon** — model loads once, stays warm across indexing runs
- **Adaptive GPU batching** — calibration probe auto-detects optimal batch size at startup

## Setup

No installation needed. ONNX provider is bundled with TeaRAGs.

```bash
# That's it — just set the provider
export EMBEDDING_PROVIDER=onnx
```

The first run downloads the model (~260 MB) to a local cache. Subsequent runs start instantly.

## Configuration

```json
{
  "mcpServers": {
    "tea-rags": {
      "command": "node",
      "args": ["/path/to/tea-rags/build/index.js"],
      "env": {
        "QDRANT_URL": "http://localhost:6333",
        "EMBEDDING_PROVIDER": "onnx"
      }
    }
  }
}
```

Optional variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `EMBEDDING_MODEL` | HuggingFace model ID | `jinaai/jina-embeddings-v2-base-code-fp16` |
| `EMBEDDING_DIMENSIONS` | Vector dimensions | `768` (auto-detected) |
| `EMBEDDING_TUNE_BATCH_SIZE` | Texts per embedding batch | Auto-calibrated |
| `EMBEDDING_DEVICE` | Compute device: `auto`, `cpu`, `webgpu`, `cuda`, `dml` | `auto` |
| `HF_TOKEN` | HuggingFace access token (for gated/private models) | — |

## Available Models

| Model | Dimensions | Notes |
|-------|-----------|-------|
| `jinaai/jina-embeddings-v2-base-code` | 768 | **Default.** Code-optimized, 30+ programming languages |
| `nomic-ai/nomic-embed-text-v1.5` | 768 | General purpose, strong quality |
| `Xenova/all-MiniLM-L6-v2` | 384 | Lightweight, fast, good for experiments |
| `Xenova/bge-base-en-v1.5` | 768 | English-focused, MTEB top-ranked |
| `Xenova/multilingual-e5-base` | 768 | 100+ languages |
| `BAAI/bge-small-en-v1.5` | 384 | Smallest footprint, fast inference |

Any ONNX-compatible model from [HuggingFace Hub](https://huggingface.co/models?library=onnx&pipeline_tag=feature-extraction&sort=trending) can be used by setting `EMBEDDING_MODEL` to the repository ID. Models with `onnx` in the library tag work out of the box.

:::tip FP16 quantization
Append `-fp16` to the model ID to use FP16-quantized weights (smaller download, faster on GPU):
```
EMBEDDING_MODEL=jinaai/jina-embeddings-v2-base-code-fp16
```
:::

## Device Options

| Device | Backend | Platform | When to use |
|--------|---------|----------|-------------|
| `auto` | Best available, with CPU fallback | All | Default, recommended |
| `webgpu` | Metal / D3D12 / Vulkan | macOS, Windows, Linux | Force WebGPU acceleration |
| `cuda` | NVIDIA CUDA | Linux x64 | NVIDIA GPUs |
| `dml` | DirectML | Windows x64/arm64 | Any GPU (NVIDIA, AMD, Intel) |
| `cpu` | CPU only | All | No GPU available or Docker |

## Private & Gated Models

Some HuggingFace models require authentication (gated models like Llama, or private repos). To use them:

1. Create an access token at [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens)
2. Add `HF_TOKEN` to your MCP config:

```json
{
  "mcpServers": {
    "tea-rags": {
      "command": "node",
      "args": ["/path/to/tea-rags/build/index.js"],
      "env": {
        "QDRANT_URL": "http://localhost:6333",
        "EMBEDDING_PROVIDER": "onnx",
        "EMBEDDING_MODEL": "your-org/private-model",
        "HF_TOKEN": "hf_..."
      }
    }
  }
}
```

## Tuning Notes

**Batch size** is auto-calibrated on first startup. The daemon runs a GPU calibration probe that tests batch sizes [1, 4, 8, 16, 32, 64, 128] and picks the optimal one for your hardware. The result is cached in `~/.tea-rags/onnx-calibration.json` — subsequent startups use the cached value instantly. Override with `EMBEDDING_TUNE_BATCH_SIZE` if needed.

**Concurrency** (`INGEST_PIPELINE_CONCURRENCY`) should stay at `1`. The ONNX daemon processes requests sequentially on a single model instance. Higher concurrency adds queue overhead without improving throughput.

**Runtime adaptation** — the daemon monitors per-text inference latency and dynamically adjusts the internal GPU batch size: halves on pressure spikes, doubles when stable. This handles thermal throttling and competing GPU workloads automatically.

## When to Use

- Small-to-medium projects (up to ~700k LoC for comfortable indexing speed)
- Air-gapped environments with no internet access (after initial model download)
- Quick experiments — no setup overhead
- CI/CD pipelines where installing Ollama is impractical
