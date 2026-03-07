---
title: Voyage AI
sidebar_position: 5
---

# Voyage AI

Cloud embedding provider using the [Voyage AI Embeddings API](https://docs.voyageai.com/docs/embeddings). Specialized models for code search.

| | |
|---|---|
| **Type** | Cloud |
| **Price** | 🟡 Pay-per-use ($0.12/1M tokens) |
| **Scale*** | ~2.4M LoC |
| **Default model** | `voyage-2` |
| **Dimensions** | 1024 |
| **URL** | [voyageai.com](https://www.voyageai.com) |

> \* Estimated lines of code for initial full indexing within 45 minutes based on default rate limits (300 RPM). Incremental reindexing is fast.

## Key Features

- **Code-specialized models** — `voyage-code-2` is trained on source code
- **High throughput** — 2,000 RPM, 3M TPM (Tier 1)
- **Batch API** — up to 1,000 texts per request (120k–1M token limit per request depending on model)
- **Custom base URL** — supports self-hosted or proxy deployments
- **Input type awareness** — separate modes for documents vs queries
- **Built-in rate limiting** — automatic retry with exponential backoff

## Setup

### 1. Get an API key

Sign up at [dash.voyageai.com](https://dash.voyageai.com) and create an API key.

### 2. Configure TeaRAGs

```bash
export EMBEDDING_PROVIDER=voyage
export VOYAGE_API_KEY=pa-...
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
        "EMBEDDING_PROVIDER": "voyage",
        "VOYAGE_API_KEY": "pa-...",
        "EMBEDDING_MODEL": "voyage-code-3"
      }
    }
  }
}
```

Optional variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `EMBEDDING_MODEL` | Voyage model name | `voyage-2` |
| `EMBEDDING_DIMENSIONS` | Vector dimensions | `1024` (auto-detected) |
| `EMBEDDING_TUNE_BATCH_SIZE` | Texts per embedding batch | `128` |
| `EMBEDDING_BASE_URL` | Custom API URL | `https://api.voyageai.com/v1` |
| `EMBEDDING_TUNE_MAX_REQUESTS_PER_MINUTE` | RPM limit for rate limiter | `300` |

## Available Models

| Model | Dimensions | Notes |
|-------|-----------|-------|
| `voyage-code-3` | 1024 | **Recommended for code.** Latest code-specialized model |
| `voyage-3-large` | 1024 | High quality, general purpose |
| `voyage-2` | 1024 | **Default.** General purpose (legacy) |
| `voyage-large-2` | 1536 | Higher quality, larger vectors (legacy) |
| `voyage-code-2` | 1536 | Code-specialized (legacy) |
| `voyage-lite-02-instruct` | 1024 | Lightweight, instruction-tuned (legacy) |

## Rate Limits by Tier

Voyage limits both RPM and TPM. The throughput bottleneck is typically **TPM** (tokens per minute). Each request can batch up to 1,000 texts.

### Base Limits (voyage-code-3)

| Tier | Min. spend to unlock | RPM | TPM | Scale in 45 min* |
|------|---------------------|-----|-----|------------------|
| Tier 1 | — | 2,000 | 3M | ~2.4M LoC |
| Tier 2 | $100 | 4,000 | 6M | ~4.7M LoC |
| Tier 3 | $1,000 | 6,000 | 9M | ~7.1M LoC |

> \* Based on average code chunk of ~625 tokens.

### TPM by Model Family (Tier 1)

| Model | TPM | RPM | Max tokens/request |
|-------|-----|-----|--------------------|
| `voyage-code-3`, `voyage-3-large` | 3M | 2,000 | 120k |
| `voyage-4`, `voyage-3.5` | 8M | 2,000 | 320k |
| `voyage-4-lite`, `voyage-3.5-lite` | 16M | 2,000 | 1M |

**Max texts per request:** 1,000

Tier 2 and Tier 3 multiply TPM and RPM by 2x and 3x respectively.

## When to Use

- Large codebases where code-specific embedding quality matters
- Teams that want the best code search quality from a cloud provider
- Projects where `voyage-code-3` outperforms general-purpose models on your codebase
- Setups requiring a custom base URL (proxy, VPN, self-hosted gateway)
