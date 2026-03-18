---
title: Troubleshooting & Error Codes
sidebar_position: 3
---

# Troubleshooting & Error Codes

## Infrastructure Issues

| Issue                          | Error Code                             | Solution                                                                                                           |
| ------------------------------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **Qdrant not running**         | `INFRA_QDRANT_UNAVAILABLE`             | Qdrant is built-in and starts automatically. If using external Qdrant: `docker compose up -d`, verify `QDRANT_URL` |
| **Qdrant operation timed out** | `INFRA_QDRANT_TIMEOUT`                 | Check Qdrant server load or increase timeout                                                                       |
| **Qdrant operation failed**    | `INFRA_QDRANT_OPERATION`               | Check Qdrant logs for details                                                                                      |
| **Qdrant unauthorized**        | —                                      | Set `QDRANT_API_KEY` environment variable for secured instances                                                    |
| **Ollama not running**         | `INFRA_EMBEDDING_OLLAMA_UNAVAILABLE`   | Verify with `curl http://localhost:11434`, start Ollama or run `docker compose up -d`                              |
| **Model missing**              | `INFRA_EMBEDDING_OLLAMA_MODEL_MISSING` | `ollama pull nomic-embed-text`                                                                                     |
| **ONNX model failed to load**  | `INFRA_EMBEDDING_ONNX_LOAD`            | Check that the model file exists and is valid                                                                      |
| **ONNX inference failed**      | `INFRA_EMBEDDING_ONNX_INFERENCE`       | Check model compatibility and input data                                                                           |
| **Rate limit errors (OpenAI)** | `INFRA_EMBEDDING_OPENAI_RATE_LIMIT`    | Adjust `EMBEDDING_MAX_REQUESTS_PER_MINUTE` to match your provider tier                                             |
| **Rate limit errors (Cohere)** | `INFRA_EMBEDDING_COHERE_RATE_LIMIT`    | Wait and retry, or adjust request rate                                                                             |
| **Rate limit errors (Voyage)** | `INFRA_EMBEDDING_VOYAGE_RATE_LIMIT`    | Wait and retry, or adjust request rate                                                                             |
| **API key errors**             | `INFRA_EMBEDDING_OPENAI_AUTH`          | Verify correct API key in environment configuration                                                                |
| **Git CLI not found**          | `INFRA_GIT_NOT_FOUND`                  | Install git                                                                                                        |
| **Git command timed out**      | `INFRA_GIT_TIMEOUT`                    | Reduce scope or increase timeout                                                                                   |
| **Alias operation failed**     | `INFRA_ALIAS_OPERATION`                | Check Qdrant server status and collection names                                                                    |

## Indexing Issues

| Issue                          | Error Code                  | Solution                                                                   |
| ------------------------------ | --------------------------- | -------------------------------------------------------------------------- |
| **Codebase not indexed**       | `INGEST_NOT_INDEXED`        | Run `index_codebase` before `search_code`                                  |
| **Collection already exists**  | `INGEST_COLLECTION_EXISTS`  | Use `forceReindex=true` or delete the collection first                     |
| **Snapshot not found**         | `INGEST_SNAPSHOT_MISSING`   | Ensure the snapshot file exists at `~/.tea-rags/snapshots/`                |
| **Snapshot corrupted**         | `INGEST_SNAPSHOT_CORRUPTED` | Delete old snapshot and re-index with `forceReindex=true`                  |
| **Snapshot migration failed**  | `INGEST_MIGRATION_FAILED`   | Delete old snapshot and re-index                                           |
| **Slow indexing**              | —                           | Use Ollama (local) for faster indexing, or increase `EMBEDDING_BATCH_SIZE` |
| **Files not found**            | —                           | Check `.gitignore` and `.contextignore` patterns                           |
| **Out of memory during index** | —                           | Reduce `CODE_CHUNK_SIZE` or `EMBEDDING_BATCH_SIZE`                         |

## Explore Issues

| Issue                               | Error Code                      | Solution                                                                  |
| ----------------------------------- | ------------------------------- | ------------------------------------------------------------------------- |
| **Collection not found**            | `EXPLORE_COLLECTION_NOT_FOUND`  | Index the codebase first with `index_codebase`                            |
| **Collection or path not provided** | `INPUT_COLLECTION_NOT_PROVIDED` | Provide a `collection` name or a `path` to the codebase                   |
| **Hybrid search not enabled**       | `EXPLORE_HYBRID_NOT_ENABLED`    | Re-create collection with `enableHybrid=true`                             |
| **Invalid query**                   | `EXPLORE_INVALID_QUERY`         | Fix query parameters                                                      |
| **Search returns no results**       | —                               | Try broader queries, check if codebase is indexed with `get_index_status` |
| **Filter errors**                   | —                               | Ensure Qdrant filter format, check field names match metadata             |

## Trajectory Issues

| Issue                 | Error Code                       | Solution                            |
| --------------------- | -------------------------------- | ----------------------------------- |
| **Git blame failed**  | `TRAJECTORY_GIT_BLAME_FAILED`    | Ensure the file is tracked by git   |
| **Git log timed out** | `TRAJECTORY_GIT_LOG_TIMEOUT`     | Reduce scope or increase timeout    |
| **Git not available** | `TRAJECTORY_GIT_NOT_AVAILABLE`   | Ensure git is installed and in PATH |
| **File parse failed** | `TRAJECTORY_STATIC_PARSE_FAILED` | File may have syntax errors         |

## Configuration Issues

| Issue                       | Error Code             | Solution                              |
| --------------------------- | ---------------------- | ------------------------------------- |
| **Invalid config value**    | `CONFIG_VALUE_INVALID` | Check expected values for the field   |
| **Required config missing** | `CONFIG_VALUE_MISSING` | Set the required environment variable |

---

## Error Codes Reference

Full table of all structured error codes returned by the MCP server.

| Code                                   | Class                        | HTTP | Message Template                                             | Hint Template                                                      |
| -------------------------------------- | ---------------------------- | ---- | ------------------------------------------------------------ | ------------------------------------------------------------------ |
| `UNKNOWN_ERROR`                        | `UnknownError`               | 500  | Unexpected error: {detail}                                   | Check server logs for details                                      |
| `INPUT_COLLECTION_NOT_PROVIDED`        | `CollectionNotProvidedError` | 400  | Either 'collection' or 'path' parameter is required.         | Provide a 'collection' name or a 'path' to the codebase.           |
| `INFRA_QDRANT_UNAVAILABLE`             | `QdrantUnavailableError`     | 503  | Qdrant is not reachable at {url}                             | Start Qdrant: `docker compose up -d`, or verify `QDRANT_URL={url}` |
| `INFRA_QDRANT_TIMEOUT`                 | `QdrantTimeoutError`         | 504  | Qdrant operation "{operation}" timed out at {url}            | Check Qdrant server load or increase timeout                       |
| `INFRA_QDRANT_OPERATION`               | `QdrantOperationError`       | 500  | Qdrant operation "{operation}" failed: {detail}              | Check Qdrant logs for details                                      |
| `INFRA_EMBEDDING_OLLAMA_UNAVAILABLE`   | `OllamaUnavailableError`     | 503  | Ollama is not reachable at {url}                             | Start Ollama or verify `OLLAMA_BASE_URL={url}`                     |
| `INFRA_EMBEDDING_OLLAMA_MODEL_MISSING` | `OllamaModelMissingError`    | 503  | Model "{model}" is not available on Ollama at {url}          | Pull the model: `ollama pull {model}`                              |
| `INFRA_EMBEDDING_ONNX_LOAD`            | `OnnxModelLoadError`         | 503  | Failed to load ONNX model from "{modelPath}"                 | Check that the model file exists and is valid                      |
| `INFRA_EMBEDDING_ONNX_INFERENCE`       | `OnnxInferenceError`         | 500  | ONNX inference failed: {detail}                              | Check model compatibility and input data                           |
| `INFRA_EMBEDDING_OPENAI_RATE_LIMIT`    | `OpenAIRateLimitError`       | 429  | OpenAI API rate limit exceeded                               | Wait and retry, or increase rate limits                            |
| `INFRA_EMBEDDING_OPENAI_AUTH`          | `OpenAIAuthError`            | 401  | OpenAI API authentication failed                             | Check `OPENAI_API_KEY` is set correctly                            |
| `INFRA_EMBEDDING_COHERE_RATE_LIMIT`    | `CohereRateLimitError`       | 429  | Cohere API rate limit exceeded                               | Wait and retry                                                     |
| `INFRA_EMBEDDING_VOYAGE_RATE_LIMIT`    | `VoyageRateLimitError`       | 429  | Voyage API rate limit exceeded                               | Wait and retry                                                     |
| `INFRA_GIT_NOT_FOUND`                  | `GitCliNotFoundError`        | 503  | Git CLI is not installed                                     | Install git                                                        |
| `INFRA_GIT_TIMEOUT`                    | `GitCliTimeoutError`         | 504  | Git command "{command}" timed out after {timeoutMs}ms        | Reduce scope or increase timeout                                   |
| `INFRA_ALIAS_OPERATION`                | `AliasOperationError`        | 500  | Alias operation "{operation}" failed: {detail}               | Check Qdrant server status and collection names                    |
| `INGEST_NOT_INDEXED`                   | `NotIndexedError`            | 404  | Codebase at "{path}" is not indexed                          | Run `index_codebase` first                                         |
| `INGEST_COLLECTION_EXISTS`             | `CollectionExistsError`      | 409  | Collection "{collectionName}" already exists                 | Use `forceReindex=true` or delete first                            |
| `INGEST_SNAPSHOT_MISSING`              | `SnapshotMissingError`       | 404  | Snapshot not found at "{path}"                               | Ensure the snapshot file exists                                    |
| `INGEST_SNAPSHOT_CORRUPTED`            | `SnapshotCorruptedError`     | 400  | Snapshot corrupted: {detail}                                 | Delete and re-index with `forceReindex=true`                       |
| `INGEST_MIGRATION_FAILED`              | `MigrationFailedError`       | 400  | Snapshot migration failed: {reason}                          | Delete old snapshot and re-index                                   |
| `EXPLORE_COLLECTION_NOT_FOUND`         | `CollectionNotFoundError`    | 404  | Collection "{collectionName}" does not exist                 | Index the codebase first                                           |
| `EXPLORE_HYBRID_NOT_ENABLED`           | `HybridNotEnabledError`      | 400  | Collection "{collectionName}" does not support hybrid search | Re-create collection with `enableHybrid=true`                      |
| `EXPLORE_INVALID_QUERY`                | `InvalidQueryError`          | 400  | Invalid query: {reason}                                      | Fix query parameters                                               |
| `TRAJECTORY_GIT_BLAME_FAILED`          | `GitBlameFailedError`        | 500  | Git blame failed for "{file}"                                | Ensure file is tracked by git                                      |
| `TRAJECTORY_GIT_LOG_TIMEOUT`           | `GitLogTimeoutError`         | 504  | Git log timed out after {timeoutMs}ms                        | Reduce scope or increase timeout                                   |
| `TRAJECTORY_GIT_NOT_AVAILABLE`         | `GitNotAvailableError`       | 503  | Git is not available                                         | Ensure git is installed and in PATH                                |
| `TRAJECTORY_STATIC_PARSE_FAILED`       | `StaticParseFailedError`     | 500  | Failed to parse "{file}"                                     | File may have syntax errors                                        |
| `CONFIG_VALUE_INVALID`                 | `ConfigValueInvalidError`    | 400  | Invalid value "{value}" for field "{field}"                  | Expected one of: {expected}                                        |
| `CONFIG_VALUE_MISSING`                 | `ConfigValueMissingError`    | 400  | Required field "{field}" is not set                          | Set the `{envVar}` environment variable                            |

---

## MCP Response Format

When an error occurs, the MCP server returns a structured JSON error response:

```json
{
  "isError": true,
  "content": [
    {
      "type": "text",
      "text": "Error [INFRA_QDRANT_UNAVAILABLE]: Qdrant is not reachable at http://localhost:6333\n\nHint: Start Qdrant: docker compose up -d, or verify QDRANT_URL=http://localhost:6333"
    }
  ]
}
```

The `text` field always follows the pattern:

```text
Error [<CODE>]: <message>

Hint: <hint>
```

For unknown/unexpected errors, the response includes the full stack trace in
debug mode:

```json
{
  "isError": true,
  "content": [
    {
      "type": "text",
      "text": "Error [UNKNOWN_ERROR]: Unexpected error: Cannot read properties of undefined\n\nHint: Check server logs for details"
    }
  ]
}
```

Enable debug logging with `DEBUG=1` to get full stack traces in the server logs.

---

## FAQ

### Does reindexing cause downtime?

No. `forceReindex` uses zero-downtime collection aliases. A new versioned
collection is built in the background while search continues on the current one.
When indexing completes, the alias is switched atomically. Search is available
100% of the time during reindexing.

### How do I know when indexing is complete?

The MCP server returns a success response with statistics (files indexed, chunks
created, time elapsed). You can also check status anytime with
`get_index_status`.

### I accidentally cancelled the request. Is my indexing lost?

No worries! Indexing continues in the background until completion. Check
progress with `get_index_status`. Already processed chunks are saved via
checkpointing.

### How do I stop indexing?

Find and kill the process:

```bash
ps aux | grep tea-rags
kill -9 <PID>
```

### How do I resume interrupted indexing?

Just run `index_codebase` again. Completed steps are cached -- only remaining
work will be processed.

### Where are cache snapshots and logs stored?

All data is stored in `~/.tea-rags/`:

- `snapshots/` -- file hash snapshots for incremental indexing
- `git-cache/` -- git blame cache (L2 disk cache)
- `logs/` -- debug logs (when `DEBUG=1`)

### How do I enable MCP logging?

Run your agent with the DEBUG variable:

```bash
DEBUG=1 claude
```

Or add `DEBUG=true` to your MCP server configuration in `env` section.
