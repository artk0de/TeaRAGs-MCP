---
title: Embedding Providers
sidebar_position: 2
---

# Embedding Providers

## Provider Comparison

| Provider   | Models                                                                                             | Dimensions     | Rate Limit | Notes                |
| ---------- | -------------------------------------------------------------------------------------------------- | -------------- | ---------- | -------------------- |
| **Ollama** | `unclemusclez/jina-embeddings-v2-base-code` **(default)**, `nomic-embed-text`, `mxbai-embed-large` | 768, 768, 1024 | None       | Local, no API key    |
| **OpenAI** | `text-embedding-3-small`, `text-embedding-3-large`                                                 | 1536, 3072     | 3500/min   | Cloud API            |
| **Cohere** | `embed-english-v3.0`, `embed-multilingual-v3.0`                                                    | 1024           | 100/min    | Multilingual support |
| **Voyage** | `voyage-2`, `voyage-large-2`, `voyage-code-2`                                                      | 1024, 1536     | 300/min    | Code-specialized     |

## Recommended: Jina Code Embeddings

For code search, we recommend **`unclemusclez/jina-embeddings-v2-base-code`** (default):

```bash
ollama pull unclemusclez/jina-embeddings-v2-base-code:latest
export EMBEDDING_MODEL="unclemusclez/jina-embeddings-v2-base-code:latest"
```

| Aspect                       | Benefit                                         |
| ---------------------------- | ----------------------------------------------- |
| **Code-optimized**           | Trained specifically on source code             |
| **Multilingual**             | 30+ programming languages                       |
| **Enterprise-proven**        | Battle-tested on 3.5M+ LOC codebases            |
| **Best performance/quality** | Optimal balance for local/on-premise setups     |
| **CPU-friendly**             | Runs efficiently without GPU (great for Ollama) |
