---
title: Configuration Variables
sidebar_position: 4
---

# Configuration Variables

TeaRAGs is configured via environment variables passed to the MCP server. All variables are optional unless specified otherwise.

## Core Configuration

| Variable                  | Description                             | Default               |
| ------------------------- | --------------------------------------- | --------------------- |
| `TRANSPORT_MODE`          | "stdio" or "http"                       | stdio                 |
| `HTTP_PORT`               | Port for HTTP transport                 | 3000                  |
| `HTTP_REQUEST_TIMEOUT_MS` | Request timeout for HTTP transport (ms) | 300000                |
| `EMBEDDING_PROVIDER`      | "ollama", "openai", "cohere", "voyage"  | ollama                |
| `QDRANT_URL`              | Qdrant server URL                       | http://localhost:6333 |
| `QDRANT_API_KEY`          | API key for Qdrant authentication       | -                     |
| `PROMPTS_CONFIG_FILE`     | Path to prompts configuration JSON      | prompts.json          |

## Embedding Configuration

| Variable                            | Description                                                | Default                                            |
| ----------------------------------- | ---------------------------------------------------------- | -------------------------------------------------- |
| `EMBEDDING_MODEL`                   | Model name                                                 | `unclemusclez/jina-embeddings-v2-base-code:latest` |
| `EMBEDDING_BASE_URL`                | Custom API URL                                             | Provider-specific                                  |
| `EMBEDDING_DIMENSION`               | Vector dimensions (auto-detected from model)               | Auto                                               |
| `EMBEDDING_BATCH_SIZE`              | Chunks per embedding batch (pipeline accumulator size)     | 1024                                               |
| `EMBEDDING_CONCURRENCY`             | Parallel embedding workers (for remote GPU latency hiding) | 1                                                  |
| `EMBEDDING_MAX_REQUESTS_PER_MINUTE` | Rate limit                                                 | Provider-specific                                  |
| `EMBEDDING_RETRY_ATTEMPTS`          | Retry count                                                | 3                                                  |
| `EMBEDDING_RETRY_DELAY`             | Initial retry delay (ms)                                   | 1000                                               |
| `OPENAI_API_KEY`                    | OpenAI API key                                             | -                                                  |
| `COHERE_API_KEY`                    | Cohere API key                                             | -                                                  |
| `VOYAGE_API_KEY`                    | Voyage AI API key                                          | -                                                  |
| `OLLAMA_NUM_GPU`                    | Ollama GPU's num (Set `0` to enable CPU only mode)         | 999                                                |

## Code Vectorization Configuration

| Variable                   | Description                                         | Default |
| -------------------------- | --------------------------------------------------- | ------- |
| `CODE_CHUNK_SIZE`          | Maximum chunk size in characters                    | 2500    |
| `CODE_CHUNK_OVERLAP`       | Overlap between chunks in characters                | 300     |
| `CODE_ENABLE_AST`          | Enable AST-aware chunking (tree-sitter)             | true    |
| `CODE_CUSTOM_EXTENSIONS`   | Additional file extensions (comma-separated)        | -       |
| `CODE_CUSTOM_IGNORE`       | Additional ignore patterns (comma-separated)        | -       |
| `CODE_DEFAULT_LIMIT`       | Default search result limit                         | 5       |
| `CODE_ENABLE_GIT_METADATA` | Enrich chunks with git blame (author, dates, tasks) | false   |

## Qdrant Batch Pipeline Configuration

| Variable                    | Description                                                      | Default |
| --------------------------- | ---------------------------------------------------------------- | ------- |
| `QDRANT_UPSERT_BATCH_SIZE`  | Points per Qdrant upsert batch                                   | 100     |
| `QDRANT_FLUSH_INTERVAL_MS`  | Auto-flush buffer interval (0 to disable timer)                  | 500     |
| `QDRANT_BATCH_ORDERING`     | Ordering mode: "weak", "medium", or "strong"                     | weak    |
| `QDRANT_DELETE_BATCH_SIZE`  | Paths per delete batch (with payload index, larger is efficient) | 500     |
| `QDRANT_DELETE_CONCURRENCY` | Parallel delete requests (Qdrant-bound, not embedding-bound)     | 8       |

## Performance & Debug Configuration

| Variable                      | Description                                         | Default |
| ----------------------------- | --------------------------------------------------- | ------- |
| `CHUNKER_POOL_SIZE`           | Worker threads for parallel AST parsing             | 4       |
| `FILE_PROCESSING_CONCURRENCY` | Parallel file read + chunk dispatch during indexing | 50      |
| `MIN_BATCH_SIZE`              | Min chunks before timeout flush (0 = no minimum)    | 0       |
| `BATCH_FORMATION_TIMEOUT_MS`  | Flush partial embedding batch after timeout (ms)    | 2000    |
| `MAX_IO_CONCURRENCY`          | Max parallel file I/O operations during cache sync  | 50      |
| `DEBUG`                       | Enable debug timing logs (`true` or `1` to enable)  | false   |

## Data Directories

The server stores data in `~/.tea-rags-mcp/`:

| Directory    | Purpose                                              |
| ------------ | ---------------------------------------------------- |
| `snapshots/` | Sharded file hash snapshots for incremental indexing |
| `logs/`      | Debug logs when `DEBUG=1` is enabled                 |
