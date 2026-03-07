---
title: Cohere
sidebar_position: 4
---

# Cohere

Cloud embedding provider using the [Cohere Embed API](https://docs.cohere.com/reference/embed). Strong multilingual support and competitive pricing.

| | |
|---|---|
| **Type** | Cloud |
| **Price** | 🟡 Pay-per-use ($0.10/1M tokens) |
| **Scale*** | ~1M LoC |
| **Default model** | `embed-english-v3.0` |
| **Dimensions** | 1024 |
| **URL** | [cohere.com](https://cohere.com) |

> \* Estimated lines of code for initial full indexing within 45 minutes based on default rate limits. Incremental reindexing is fast.

## Key Features

- **Multilingual embeddings** — 100+ languages in a single model
- **Input type awareness** — separate embeddings for documents vs queries
- **Batch API** — up to 96 texts per request
- **Light models** — 384-dimension variants for resource-constrained setups
- **Built-in rate limiting** — automatic retry with exponential backoff
- **2,000 inputs/min** — rate limit applies to total inputs, not requests

## Setup

### 1. Get an API key

Sign up at [dashboard.cohere.com](https://dashboard.cohere.com) and create an API key.

### 2. Configure TeaRAGs

```bash
export EMBEDDING_PROVIDER=cohere
export COHERE_API_KEY=...
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
        "EMBEDDING_PROVIDER": "cohere",
        "COHERE_API_KEY": "..."
      }
    }
  }
}
```

Optional variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `EMBEDDING_MODEL` | Cohere model name | `embed-english-v3.0` |
| `EMBEDDING_DIMENSIONS` | Vector dimensions | `1024` (auto-detected) |
| `EMBEDDING_TUNE_BATCH_SIZE` | Texts per embedding batch | `96` |
| `EMBEDDING_TUNE_MAX_REQUESTS_PER_MINUTE` | RPM limit for rate limiter | `100` |

## Available Models

| Model | Dimensions | Notes |
|-------|-----------|-------|
| `embed-english-v3.0` | 1024 | **Default.** Best quality for English |
| `embed-multilingual-v3.0` | 1024 | 100+ languages |
| `embed-english-light-v3.0` | 384 | Lightweight, faster |
| `embed-multilingual-light-v3.0` | 384 | Lightweight, multilingual |

## Rate Limits

| | Trial | Production |
|---|-------|------------|
| **Embed inputs/min** | 2,000 | 2,000 |
| **Max texts/request** | 96 | 96 |
| **EmbedJob RPM** | 5 | 50 |

Cohere limits by **inputs per minute** (total texts across all requests), not by RPM. With 2,000 inputs/min and ~625 tokens per code chunk, the 45-minute throughput is ~90k chunks ≈ **~1M LoC**. Contact support@cohere.com for higher limits.

## When to Use

- Codebases with multilingual content (comments, docs, variable names in multiple languages)
- Teams that need both code search and documentation search across languages
- Projects where 1024 dimensions is a good balance between quality and storage
