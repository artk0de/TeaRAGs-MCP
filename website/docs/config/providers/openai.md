---
title: OpenAI
sidebar_position: 3
---

# OpenAI

Cloud embedding provider using the [OpenAI Embeddings API](https://platform.openai.com/docs/guides/embeddings). High quality, easy setup, widely adopted.

| | |
|---|---|
| **Type** | Cloud |
| **Price** | 🟡 Pay-per-use ($0.02/1M tokens) |
| **Scale*** | ~800k–8M LoC (depends on API tier) |
| **Default model** | `text-embedding-3-small` |
| **Dimensions** | 1536 |
| **URL** | [platform.openai.com](https://platform.openai.com) |

> \* Estimated lines of code for initial full indexing within 45 minutes. Incremental reindexing is fast. Scale depends on your OpenAI API tier (TPM limits).

## Key Features

- **High embedding quality** — state-of-the-art models
- **Batch API** — up to 2048 texts per request
- **Flexible dimensions** — `text-embedding-3-*` models support custom dimension reduction
- **Built-in rate limiting** — automatic retry with exponential backoff and Retry-After header support
- **8,191 tokens per input** — handles large code chunks without truncation
- **Familiar API** — if you already have an OpenAI key, you're ready to go

## Setup

### 1. Get an API key

Go to [platform.openai.com/api-keys](https://platform.openai.com/api-keys) and create a new key.

### 2. Configure TeaRAGs

```bash
export EMBEDDING_PROVIDER=openai
export OPENAI_API_KEY=sk-...
```

## Configuration

```json
{
  "mcpServers": {
    "tea-rags": {
      "command": "node",
      "args": ["/path/to/tea-rags-mcp/build/index.js"],
      "env": {
        "QDRANT_URL": "http://localhost:6333",
        "EMBEDDING_PROVIDER": "openai",
        "OPENAI_API_KEY": "sk-..."
      }
    }
  }
}
```

Optional variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `EMBEDDING_MODEL` | OpenAI model name | `text-embedding-3-small` |
| `EMBEDDING_DIMENSIONS` | Vector dimensions (supports reduction) | `1536` (auto-detected) |
| `EMBEDDING_TUNE_BATCH_SIZE` | Texts per embedding batch | `2048` |
| `EMBEDDING_TUNE_MAX_REQUESTS_PER_MINUTE` | RPM limit for rate limiter | `3500` |

## Available Models

| Model | Dimensions | Price | Notes |
|-------|-----------|-------|-------|
| `text-embedding-3-small` | 1536 | $0.02/1M tokens | **Default.** Best price/quality ratio |
| `text-embedding-3-large` | 3072 | $0.13/1M tokens | Highest quality |
| `text-embedding-ada-002` | 1536 | $0.10/1M tokens | Legacy, not recommended for new projects |

### Dimension Reduction

`text-embedding-3-*` models support reducing dimensions without retraining. Lower dimensions = smaller vectors, faster search, lower Qdrant storage:

```bash
EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_DIMENSIONS=512  # reduced from 1536
```

## Rate Limits by Tier

The throughput bottleneck for OpenAI is **TPM** (tokens per minute), not RPM. Each request can batch up to 2048 texts, so RPM is rarely the limit.

| Tier | Min. spend to unlock | RPM | TPM | Scale in 45 min* |
|------|---------------------|-----|-----|------------------|
| Free | — | 500 | 150k | ~120k LoC |
| Tier 1 | $5 | 500 | 1M | ~800k LoC |
| Tier 2 | $50 | 500 | 1M | ~800k LoC |
| Tier 3 | $100 | 5,000 | 5M | ~3.9M LoC |
| Tier 4 | $250 | 5,000 | 5M | ~3.9M LoC |
| Tier 5 | $1,000 | 10,000 | 10M | ~7.8M LoC |

> \* Based on average code chunk of ~625 tokens.
