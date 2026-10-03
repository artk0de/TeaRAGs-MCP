---
title: Overview
sidebar_position: 0
---

# Embedding Providers

TeaRAGs supports six embedding providers — from zero-config local inference to high-throughput cloud APIs. Choose based on your codebase size, privacy requirements, and budget.

## Provider Comparison

| Provider | Type | Price | Scale* | Key Feature |
|----------|------|-------|--------|-------------|
| [**ONNX**](./onnx) | Local | 🟢 Free | ~700k LoC | Zero-config, built-in runtime, adaptive GPU batching |
| [**Ollama**](./ollama) | Local | 🟢 Free | ~8M+ LoC (depends on hardware) | **Default.** GPU acceleration, 100+ models |
| [**llama-server**](./llama-server) | Local / LAN | 🟢 Free | Recommended for 3M+ LoC | ~2× Ollama on the same GPU, several GPUs as peers |
| [**OpenAI**](./openai) | Cloud | 🟡 Pay-per-use ($0.02/1M tokens) | ~800k–8M LoC (depends on API tier) | Highest quality, easy setup |
| [**Cohere**](./cohere) | Cloud | 🟡 Pay-per-use ($0.10/1M tokens) | ~1M LoC | Multilingual support |
| [**Voyage**](./voyage) | Cloud | 🟡 Pay-per-use ($0.12/1M tokens) | ~2.4M LoC | Code-specialized models |

> \* Estimated lines of code for initial full indexing within 45 minutes. Benchmarked on Apple M3 Pro with WebGPU — actual throughput depends on your hardware. Incremental reindexing is fast on any provider — typically only 1–5% of files change between runs.

## How to Choose

**Want zero setup?** Start with [ONNX](./onnx) — no external services, no API keys, works out of the box. Best for small-to-medium projects.

**Have a GPU?** Use [Ollama](./ollama) — free, private, and handles millions of lines of code. The default choice for serious local development.

**Large project and a GPU host?** For 3M+ indexed lines, run [llama-server](./llama-server) on the GPU host — two or three instances per discrete GPU, with a local llama-server as the fallback. It embeds about three times as fast as Ollama on the same host (measured 3.4× on an RX 7800M plus Arc iGPU), at the cost of setting up llama.cpp builds yourself. See the [multi-GPU guide](./llama-server-multi-gpu) and [measured configurations](./llama-server-benchmarks).

**Need cloud scale or quality?** Pick [OpenAI](./openai) for the best embedding quality and familiar API. Consider [Voyage](./voyage) if your codebase is code-heavy — their models are trained specifically on source code. Choose [Cohere](./cohere) if you need multilingual embeddings.

**Which model?** The provider decides which models you can run; which of them
to pick for a project is on [Embedding model choice](/config/embedding-model-choice).

**Privacy matters?** ONNX, Ollama and llama-server keep everything local or on your own network. No data leaves your machine.

## Common Configuration

All providers share these tuning variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `EMBEDDING_PROVIDER` | Provider name: `onnx`, `ollama`, `llama-server`, `openai`, `cohere`, `voyage` | `ollama` |
| `EMBEDDING_MODEL` | Model name (provider-specific) | Provider default |
| `EMBEDDING_DIMENSIONS` | Vector width. Ollama and ONNX report it at startup; other providers fall back to a built-in model table. Set it to pin the value. | Resolved |
| `EMBEDDING_TUNE_BATCH_SIZE` | Texts per embedding batch | **Provider-specific** (see below) |
| `EMBEDDING_TUNE_RETRY_ATTEMPTS` | Retry count on failure | `3` |
| `EMBEDDING_TUNE_RETRY_DELAY_MS` | Initial retry delay (exponential backoff) | `1000` |

### Default Batch Sizes

`EMBEDDING_TUNE_BATCH_SIZE` is **automatically set per provider** — you don't need to configure it unless you want to override. Defaults are optimized based on API limits and throughput characteristics:

| Provider | Default Batch Size | Rationale |
|----------|-------------------|-----------|
| ONNX | Auto-calibrated | GPU probe sets optimal batch size at startup |
| Ollama | 1024 | GPU-optimized, native batch API |
| llama-server | 256 | Fanned out across every GPU endpoint and its slots: 256 over two GPUs at `-np 4` is 8 parallel requests of ~32 texts |
| OpenAI | 2048 | Max texts per API request |
| Cohere | 96 | API limit: 96 texts per request |
| Voyage | 128 | Balanced for 120k token/request limit |

Override with `EMBEDDING_TUNE_BATCH_SIZE` if needed. The value is a ceiling:
during a run the batch size moves below it toward the fastest measured size, and
drops after a batch the server fails on size. See
[Adaptive Embedding](/config/performance-tuning#adaptive-embedding).

:::note Pipeline Concurrency
With adaptive embedding the run measures embedding concurrency: once the batch size settles, concurrency is probed at half and double the current value inside [1, ceiling] and kept only when aggregate throughput improves by 5% or more. The address of the endpoint plays no part. Unset, `INGEST_PIPELINE_CONCURRENCY` leaves the climb an implicit ceiling of 8, starting from 1 or the stored optimum; set it (even to `1`) and your value becomes the hard ceiling. llama-server already keeps its slots busy within one batch. `EMBEDDING_TUNE_STATIC=true` applies the value as written (1 when unset). See [Adaptive Embedding](/config/performance-tuning#adaptive-embedding).
:::

See individual provider pages for provider-specific variables and setup instructions.

## Embedding Model Comparison

Every model TeaRAGs knows the vector width of, with the providers that serve
it. Other models work too: Ollama and ONNX report the width at startup,
llama-server measures it with one probe embed, and `EMBEDDING_DIMENSIONS` pins
it for any provider.

Context windows are taken from each model's card or the provider's
documentation; "—" marks a value we could not verify there. They are the
models' limits, not what a run uses: when the provider reports a context length
at startup (Ollama, ONNX, and llama-server's per-slot window), TeaRAGs derives
the default chunk size from that reported value, which may be smaller.

| Model | Served by | Dimensions | Context (tokens) | Kind | Notes |
| ----- | --------- | ---------- | ---------------- | ---- | ----- |
| `unclemusclez/jina-embeddings-v2-base-code:latest` | Ollama, llama-server | 768 | 8192 | Code | **Default** for Ollama and llama-server. The llama-server throughput numbers on the provider pages are measured with it |
| `jina-embeddings-v2-base-code` | Ollama, llama-server¹ | 768 | 8192 | Code | Same model under its plain name |
| `jinaai/jina-embeddings-v2-base-code` | ONNX | 768 | 8192 | Code | ONNX default as `jinaai/jina-embeddings-v2-base-code-fp16` |
| `nomic-embed-text` | Ollama, llama-server¹ | 768 | 8192 | General | |
| `nomic-ai/nomic-embed-text-v1.5` | ONNX | 768 | 8192 | General | Matryoshka: 512/256/128/64 also supported |
| `mxbai-embed-large` | Ollama, llama-server¹ | 1024 | 512 | General | Short context: long functions are split into small chunks |
| `all-minilm` | Ollama, llama-server¹ | 384 | 256 | General | Card truncates at 256 word pieces; Ollama's library lists 512. Lightweight |
| `qwen3-embedding` | Ollama, llama-server¹ | 1024 | 32k | General | Multilingual. 1024 is the 0.6B size; larger sizes are wider, and Ollama reports the real width at startup |
| `bge-m3` | Ollama, llama-server¹ | 1024 | 8192 | General | Multilingual |
| `embeddinggemma` | Ollama, llama-server¹ | 768 | 2048 | General | Matryoshka: 512/256/128 also supported |
| `nomic-ai/CodeRankEmbed` | llama-server³ | 768 | 2048 | Code | **Recommended for llama-server**: 0.93× jina's speed, +0.06 to +0.19 MRR over it. Context from the GGUF metadata. See [Embedding model choice](/config/embedding-model-choice) |
| `brokkai/Muninn-small` | llama-server³ | 384 | 8192 | Code | Fast option: 2.37× jina's speed; no Ruby in its training data. See [Embedding model choice](/config/embedding-model-choice) |
| `jinaai/jina-code-embeddings-0.5b` | llama-server³ | 896 | — | Code | Measured, not recommended: 0.12× jina's speed, CC-BY-NC. See the [comparison](/knowledge-base/embedding-model-comparison) |
| `BAAI/bge-code-v1` | llama-server³ | 1536 | — | Code | Measured, not recommended: 0.06× jina's speed. See the [comparison](/knowledge-base/embedding-model-comparison) |
| `Qodo/Qodo-Embed-1-1.5B` | llama-server³ | 1536 | — | Code | Measured, not recommended: 0.06× jina's speed. See the [comparison](/knowledge-base/embedding-model-comparison) |
| `nomic-ai/nomic-embed-code` | llama-server³ | 3584 | — | Code | Measured, not recommended: 7B, 0.009× jina's speed. See the [comparison](/knowledge-base/embedding-model-comparison) |
| `Xenova/all-MiniLM-L6-v2` | ONNX | 384 | 256 | General | Lightweight |
| `Xenova/bge-base-en-v1.5` | ONNX | 768 | 512 | General | English |
| `BAAI/bge-small-en-v1.5` | ONNX | 384 | 512 | General | English, small |
| `Xenova/multilingual-e5-base` | ONNX | 768 | 512 | General | Multilingual |
| `text-embedding-3-small` | OpenAI | 1536 | 8192 | General | OpenAI default |
| `text-embedding-3-large` | OpenAI | 3072 | 8192 | General | |
| `text-embedding-ada-002` | OpenAI | 1536 | 8192 | General | Previous generation |
| `embed-english-v3.0` | Cohere | 1024 | 512 | General | Cohere default |
| `embed-multilingual-v3.0` | Cohere | 1024 | 512 | General | Multilingual |
| `embed-english-light-v3.0` | Cohere | 384 | 512 | General | Smaller, faster |
| `embed-multilingual-light-v3.0` | Cohere | 384 | 512 | General | Multilingual, smaller |
| `voyage-code-3` | Voyage | 1024 | 32000 | Code | |
| `voyage-code-2` | Voyage | 1536 | — | Code | Previous generation |
| `voyage-2` | Voyage | 1024 | 4000 | General | Voyage default |
| `voyage-large-2` | Voyage | 1536 | 16000 | General | |
| `voyage-3-large` | Voyage | 1024 | 32000 | General | |
| `voyage-3.5` | Voyage | 1024 | 32000 | General | |
| `voyage-3.5-lite` | Voyage | 512² | 32000 | General | |
| `voyage-4` | Voyage | 1024 | 32000 | General | |
| `voyage-4-lite` | Voyage | 512² | 32000 | General | |
| `voyage-lite-02-instruct` | Voyage | 1024 | — | General | Previous generation |

¹ llama-server serves any model from the Ollama library: `tea-rags llama-server
fetch-model <model>` downloads its GGUF, and `tea-rags llama-server command
--model <model>` prints the download for the GPU host. It loads only when
llama.cpp supports the model's architecture. Of the models marked ¹, only the
jina default and `mxbai-embed-large` have been measured with TeaRAGs.

² TeaRAGs' built-in table assumes 512 for the two Voyage lite models, while
Voyage documents 1024 as their default output width. Set
`EMBEDDING_DIMENSIONS=1024` when you use them.

³ A HuggingFace GGUF served by llama-server, named by its HuggingFace id. The
width is the length of the vectors a live llama-server returned for it
(measured 2026-10-03). None of these models is in the Ollama library, so
`fetch-model` and the download step of `command`, which take Ollama references,
do not cover them yet: download a community GGUF or convert the HuggingFace
model with llama.cpp's `convert_hf_to_gguf.py`, and pass its path to
`command --model`. Speed and quality of each are in
[Embedding model comparison](/knowledge-base/embedding-model-comparison).
