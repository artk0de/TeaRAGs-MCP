---
title: Overview
sidebar_position: 0
---

# Embedding Providers

TeaRAGs supports five embedding providers — from zero-config local inference to high-throughput cloud APIs. Choose based on your codebase size, privacy requirements, and budget.

## Provider Comparison

| Provider | Type | Price | Scale* | Key Feature |
|----------|------|-------|--------|-------------|
| [**ONNX**](./onnx) | Local | 🟢 Free | ~700k LoC | Zero-config, built-in runtime, adaptive GPU batching |
| [**Ollama**](./ollama) | Local | 🟢 Free | ~8M+ LoC (depends on hardware) | GPU acceleration, 100+ models |
| [**OpenAI**](./openai) | Cloud | 🟡 Pay-per-use ($0.02/1M tokens) | ~800k–8M LoC (depends on API tier) | Highest quality, easy setup |
| [**Cohere**](./cohere) | Cloud | 🟡 Pay-per-use ($0.10/1M tokens) | ~1M LoC | Multilingual support |
| [**Voyage**](./voyage) | Cloud | 🟡 Pay-per-use ($0.12/1M tokens) | ~2.4M LoC | Code-specialized models |

> \* Estimated lines of code for initial full indexing within 45 minutes. Benchmarked on Apple M3 Pro with WebGPU — actual throughput depends on your hardware. Incremental reindexing is fast on any provider — typically only 1–5% of files change between runs.

## How to Choose

**Want zero setup?** Start with [ONNX](./onnx) — no external services, no API keys, works out of the box. Best for small-to-medium projects.

**Have a GPU?** Use [Ollama](./ollama) — free, private, and handles millions of lines of code. The default choice for serious local development.

**Need cloud scale or quality?** Pick [OpenAI](./openai) for the best embedding quality and familiar API. Consider [Voyage](./voyage) if your codebase is code-heavy — their models are trained specifically on source code. Choose [Cohere](./cohere) if you need multilingual embeddings.

**Privacy matters?** ONNX and Ollama keep everything local. No data leaves your machine.

## Common Configuration

All providers share these tuning variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `EMBEDDING_PROVIDER` | Provider name: `onnx`, `ollama`, `openai`, `cohere`, `voyage` | `ollama` |
| `EMBEDDING_MODEL` | Model name (provider-specific) | Provider default |
| `EMBEDDING_DIMENSIONS` | Vector dimensions (auto-detected from model) | Auto |
| `EMBEDDING_TUNE_BATCH_SIZE` | Texts per embedding batch | **Provider-specific** (see below) |
| `EMBEDDING_TUNE_RETRY_ATTEMPTS` | Retry count on failure | `3` |
| `EMBEDDING_TUNE_RETRY_DELAY_MS` | Initial retry delay (exponential backoff) | `1000` |

### Default Batch Sizes

`EMBEDDING_TUNE_BATCH_SIZE` is **automatically set per provider** — you don't need to configure it unless you want to override. Defaults are optimized based on API limits and throughput characteristics:

| Provider | Default Batch Size | Rationale |
|----------|-------------------|-----------|
| ONNX | Auto-calibrated | GPU probe sets optimal batch size at startup |
| Ollama | 1024 | GPU-optimized, native batch API |
| OpenAI | 2048 | Max texts per API request |
| Cohere | 96 | API limit: 96 texts per request |
| Voyage | 128 | Balanced for 120k token/request limit |

Override with `EMBEDDING_TUNE_BATCH_SIZE` if needed.

:::note Pipeline Concurrency
`INGEST_PIPELINE_CONCURRENCY` controls pipeline worker concurrency (default: `1`). The pipeline already handles parallelism via batch accumulation, and increasing concurrency adds complexity without improving throughput for most providers. Leave at `1` unless you have a specific reason to change it.
:::

See individual provider pages for provider-specific variables and setup instructions.
