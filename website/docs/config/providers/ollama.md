---
title: Ollama
sidebar_position: 2
---

# Ollama

Local embedding provider running models via [Ollama](https://ollama.com).
GPU-accelerated, private, and proven on multi-million LoC codebases.

|                   |                                                    |
| ----------------- | -------------------------------------------------- |
| **Type**          | Local                                              |
| **Price**         | 🟢 Free                                            |
| **Scale\***       | ~8M+ LoC (depends on hardware)                     |
| **Default model** | `unclemusclez/jina-embeddings-v2-base-code:latest` |
| **Dimensions**    | 768                                                |
| **URL**           | [ollama.com](https://ollama.com)                   |

> \* Estimated lines of code for initial full indexing within 45 minutes.
> Incremental reindexing is fast.

## Key Features

- **GPU acceleration** — leverages your GPU for fast inference
- **Native batch API** — sends multiple texts in a single request (`/api/embed`)
- **100+ models** — any Ollama-compatible embedding model
- **No API keys** — fully local, no data leaves your machine
- **Battle-tested** — proven on 3.5M+ LoC enterprise codebases
- **Auto-fallback** — gracefully falls back to legacy API on older Ollama
  versions

## Setup

### 1. Install Ollama

:::warning

macOS: use Ollama.app for GPU acceleration On macOS, the
`brew install ollama` CLI-only package **does not include GPU support**.
Embeddings will run on CPU and be significantly slower.

To use Metal GPU acceleration, install the full
[Ollama.app](https://ollama.com/download/mac):

```bash
# Download Ollama.app (includes Metal GPU support)
open https://ollama.com/download/mac
```

If you only need the CLI (no GPU):

```bash
brew install ollama
```

:::

**Linux:**

```bash
curl -fsSL https://ollama.com/install.sh | sh
```

:::tip Advanced GPU Setup

For advanced GPU setup (Docker, remote Ollama, exposed GPU), see the
[Local & Exposed GPU Setup](../local-exposed-gpu-setup) guide.

:::

### 2. Pull the embedding model

```bash
ollama pull unclemusclez/jina-embeddings-v2-base-code:latest
```

### 3. Configure TeaRAGs

```bash
export EMBEDDING_PROVIDER=ollama  # default, can be omitted
export EMBEDDING_BASE_URL=http://localhost:11434
```

## Configuration

```json
{
  "mcpServers": {
    "tea-rags": {
      "command": "node",
      "args": ["/path/to/tea-rags/build/index.js"],
      "env": {
        "EMBEDDING_PROVIDER": "ollama",
        "EMBEDDING_BASE_URL": "http://localhost:11434"
      }
    }
  }
}
```

:::tip

`QDRANT_URL` is not needed — Qdrant is built-in and starts automatically.
Add it only if using external Qdrant.

:::
Optional variables:

| Variable                    | Description                                     | Default                                            |
| --------------------------- | ----------------------------------------------- | -------------------------------------------------- |
| `EMBEDDING_MODEL`           | Ollama model name                               | `unclemusclez/jina-embeddings-v2-base-code:latest` |
| `EMBEDDING_DIMENSIONS`      | Vector width. Resolved from Ollama at startup; set only to pin it | Resolved                     |
| `EMBEDDING_FALLBACK_URL`    | Fallback Ollama URL when primary is unreachable | -                                                  |
| `EMBEDDING_TUNE_BATCH_SIZE` | Ceiling on texts per embedding batch            | `1024`                                             |
| `OLLAMA_NUM_GPU`            | GPU layers to offload (`0` = CPU only)          | `999` (all)                                        |
| `OLLAMA_LEGACY_API`         | Use `/api/embeddings` instead of `/api/embed`   | `false`                                            |

:::tip

Failover for remote GPU setups If your primary Ollama runs on a remote
GPU server, set `EMBEDDING_FALLBACK_URL` to a local instance as backup:

```bash
export EMBEDDING_BASE_URL=http://gpu-server:11434      # primary (remote GPU)
export EMBEDDING_FALLBACK_URL=http://localhost:11434    # fallback (local Mac)
```

When the primary is unreachable, TeaRAGs automatically retries on the fallback
URL. If both fail, the error message includes both URLs and suggests
`ollama serve` if either points to localhost.

:::

## Available Models

| Model                                              | Dimensions | Notes                                      |
| -------------------------------------------------- | ---------- | ------------------------------------------ |
| `unclemusclez/jina-embeddings-v2-base-code:latest` | 768        | **Default.** Code-optimized, 30+ languages |
| `nomic-embed-text`                                 | 768        | General purpose, good quality              |
| `mxbai-embed-large`                                | 1024       | Higher dimensions, better quality          |
| `all-minilm`                                       | 384        | Lightweight, fast                          |

Pull any model with `ollama pull <model>` and set `EMBEDDING_MODEL` accordingly.

## Performance Tuning

| Variable                    | Description                                   | Default     | Tip                         |
| --------------------------- | --------------------------------------------- | ----------- | --------------------------- |
| `OLLAMA_NUM_GPU`            | GPU layers to offload                         | `999` (all) | Set `0` for CPU-only        |
| `EMBEDDING_TUNE_BATCH_SIZE` | Ceiling on texts per batch                    | `1024`      | Increase for high-VRAM GPUs |
| `OLLAMA_LEGACY_API`         | Use `/api/embeddings` instead of `/api/embed` | `false`     | Only for Ollama < 0.2.0     |

Within that ceiling the batch size is chosen during the run: when Ollama fails
a batch on size (a runner crash, an HTTP 400) the size is halved for every later
batch and recovers after a streak of successes, and otherwise moves toward the
fastest measured size. A `localhost` Ollama runs at concurrency 1. See
[Adaptive Embedding](/config/performance-tuning#adaptive-embedding); the
settled size is reported in `get_index_status` as
`infraHealth.embedding.throughputTune`.

**Context window.** Every embed request sets `num_ctx` and `num_batch` to the
model's context length, capped at 8192 tokens. Ollama's default batch window of
2048 tokens otherwise limits a single input to 2048 tokens: a chunk at the
chunk-size cap in a token-dense script (Cyrillic or CJK text, for example) was
either truncated silently or failed the whole batch with HTTP 400.

### Batch Size Guidelines

| VRAM   | Recommended batch size |
| ------ | ---------------------- |
| 4 GB   | 32–64                  |
| 8 GB   | 64–256                 |
| 12+ GB | 512–2048+              |
