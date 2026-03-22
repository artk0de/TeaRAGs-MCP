---
title: Configuration Variables
sidebar_position: 5
---

# Configuration Variables

TeaRAGs is configured via environment variables passed to the MCP server. All
variables are optional unless specified otherwise.

## Server

| Variable                 | Description                             | Default        |
| ------------------------ | --------------------------------------- | -------------- |
| `SERVER_TRANSPORT`       | Transport mode: `stdio` or `http`       | `stdio`        |
| `SERVER_HTTP_PORT`       | Port for HTTP transport                 | `3000`         |
| `SERVER_HTTP_TIMEOUT_MS` | Request timeout for HTTP transport (ms) | `300000`       |
| `SERVER_PROMPTS_FILE`    | Path to prompts configuration JSON      | `prompts.json` |

## Qdrant

| Variable                       | Description                                                                                                                                                                                                     | Default                      |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `QDRANT_URL`                   | Qdrant connection mode. **Unset** = autodetect (probe `localhost:6333` for external Qdrant, fallback to embedded). `"embedded"` = always use embedded Qdrant. `"http://..."` = use external Qdrant at that URL. | Autodetect                   |
| `QDRANT_API_KEY`               | API key for Qdrant authentication                                                                                                                                                                               | -                            |
| `QDRANT_EMBEDDED_STORAGE_PATH` | Override embedded Qdrant storage location                                                                                                                                                                       | `~/.tea-rags/qdrant/storage` |

## Embedding

| Variable                 | Description                                              | Default                        |
| ------------------------ | -------------------------------------------------------- | ------------------------------ |
| `EMBEDDING_PROVIDER`     | Provider: `onnx`, `ollama`, `openai`, `cohere`, `voyage` | `ollama`                       |
| `EMBEDDING_MODEL`        | Model name                                               | `jina-embeddings-v2-base-code` |
| `EMBEDDING_BASE_URL`     | Custom API URL                                           | Provider-specific              |
| `EMBEDDING_FALLBACK_URL` | Fallback Ollama URL when primary is unreachable          | -                              |
| `EMBEDDING_DIMENSIONS`   | Vector dimensions (auto-detected from model)             | Auto                           |
| `OPENAI_API_KEY`         | OpenAI API key                                           | -                              |
| `COHERE_API_KEY`         | Cohere API key                                           | -                              |
| `VOYAGE_API_KEY`         | Voyage AI API key                                        | -                              |
| `OLLAMA_LEGACY_API`      | Use legacy single-request Ollama API                     | `false`                        |
| `OLLAMA_NUM_GPU`         | Ollama GPU count (`0` = CPU only)                        | `999`                          |

## Ingest

| Variable                      | Description                                   | Default |
| ----------------------------- | --------------------------------------------- | ------- |
| `INGEST_CHUNK_SIZE`           | Maximum chunk size in characters              | `2500`  |
| `INGEST_CHUNK_OVERLAP`        | Overlap between chunks in characters          | `300`   |
| `INGEST_ENABLE_AST`           | Enable AST-aware chunking (tree-sitter)       | `true`  |
| `INGEST_ENABLE_HYBRID`        | Enable hybrid search (dense + sparse vectors) | `true`  |
| `INGEST_DEFAULT_SEARCH_LIMIT` | Default search result limit                   | `5`     |

## Trajectory: Git

| Variable                               | Description                                          | Default  |
| -------------------------------------- | ---------------------------------------------------- | -------- |
| `TRAJECTORY_GIT_ENABLED`               | Enable git enrichment (file + chunk signals)         | `false`  |
| `TRAJECTORY_GIT_LOG_MAX_AGE_MONTHS`    | Git log depth for file-level signals (months)        | `12`     |
| `TRAJECTORY_GIT_LOG_TIMEOUT_MS`        | Timeout for `git log --numstat` (ms)                 | `60000`  |
| `TRAJECTORY_GIT_CHUNK_CONCURRENCY`     | Parallel files for chunk-level churn analysis        | `10`     |
| `TRAJECTORY_GIT_CHUNK_MAX_AGE_MONTHS`  | Git log depth for chunk-level churn (months)         | `6`      |
| `TRAJECTORY_GIT_CHUNK_TIMEOUT_MS`      | Timeout for chunk churn CLI pathspec (ms)            | `120000` |
| `TRAJECTORY_GIT_CHUNK_MAX_FILE_LINES`  | Skip chunk churn for files > N lines                 | `10000`  |
| `TRAJECTORY_GIT_SQUASH_AWARE_SESSIONS` | Group commits into sessions (squash noise reduction) | `false`  |
| `TRAJECTORY_GIT_SESSION_GAP_MINUTES`   | Gap between commits to split sessions                | `30`     |

## Debug

| Variable | Description                              | Default |
| -------- | ---------------------------------------- | ------- |
| `DEBUG`  | Enable debug timing logs (`true` or `1`) | `false` |

## Performance Tuning

:::tip These variables control batch sizes, concurrency, timeouts, and pool
sizes. Defaults work well for most setups. Tune only if you hit performance
bottlenecks. :::

### Qdrant Tune

| Variable                               | Description                               | Default |
| -------------------------------------- | ----------------------------------------- | ------- |
| `QDRANT_TUNE_UPSERT_BATCH_SIZE`        | Points per Qdrant upsert batch            | `100`   |
| `QDRANT_TUNE_UPSERT_FLUSH_INTERVAL_MS` | Auto-flush buffer interval (0 to disable) | `500`   |
| `QDRANT_TUNE_UPSERT_ORDERING`          | Ordering: `weak`, `medium`, `strong`      | `weak`  |
| `QDRANT_TUNE_DELETE_BATCH_SIZE`        | Paths per delete batch                    | `500`   |
| `QDRANT_TUNE_DELETE_CONCURRENCY`       | Parallel delete requests                  | `8`     |
| `QDRANT_TUNE_DELETE_FLUSH_TIMEOUT_MS`  | Flush timeout for delete accumulator (ms) | `1000`  |

### Embedding Tune

| Variable                                 | Description                            | Default           |
| ---------------------------------------- | -------------------------------------- | ----------------- |
| `INGEST_PIPELINE_CONCURRENCY`            | Pipeline worker concurrency            | `1`               |
| `EMBEDDING_TUNE_BATCH_SIZE`              | Chunks per embedding batch             | `1024`            |
| `EMBEDDING_TUNE_MIN_BATCH_SIZE`          | Min chunks before timeout flush        | `batchSize × 0.5` |
| `EMBEDDING_TUNE_BATCH_TIMEOUT_MS`        | Flush partial batch after timeout (ms) | `2000`            |
| `EMBEDDING_TUNE_MAX_REQUESTS_PER_MINUTE` | Rate limit for embedding API           | Provider-specific |
| `EMBEDDING_TUNE_RETRY_ATTEMPTS`          | Retry count for failed embedding calls | `3`               |
| `EMBEDDING_TUNE_RETRY_DELAY_MS`          | Initial retry delay (ms)               | `1000`            |

### Ingest Tune

| Variable                        | Description                             | Default |
| ------------------------------- | --------------------------------------- | ------- |
| `INGEST_TUNE_CHUNKER_POOL_SIZE` | Worker threads for parallel AST parsing | `4`     |
| `INGEST_TUNE_FILE_CONCURRENCY`  | Parallel file read + chunk dispatch     | `50`    |
| `INGEST_TUNE_IO_CONCURRENCY`    | Max parallel file I/O during cache sync | `50`    |

## Data Directories

The server stores data in `~/.tea-rags/`:

| Directory    | Purpose                                              |
| ------------ | ---------------------------------------------------- |
| `snapshots/` | Sharded file hash snapshots for incremental indexing |
| `logs/`      | Debug logs when `DEBUG=1` is enabled                 |
