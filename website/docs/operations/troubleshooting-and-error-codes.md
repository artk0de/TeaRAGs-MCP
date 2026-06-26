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
| **File skipped (quarantined)** | `INGEST_FILE_*`/`OVERSIZED` | Set aside + auto-retried - see [Quarantine](/operations/quarantine)        |
| **Slow indexing**              | —                           | Use Ollama (local) for faster indexing, or increase `EMBEDDING_BATCH_SIZE` |
| **Files not found**            | —                           | Check `.gitignore` and `.contextignore` patterns                           |
| **Out of memory during index** | —                           | Reduce `INGEST_CHUNK_SIZE` or `EMBEDDING_BATCH_SIZE`                       |

## Explore Issues

| Issue                               | Error Code                      | Solution                                                                  |
| ----------------------------------- | ------------------------------- | ------------------------------------------------------------------------- |
| **Collection not found**            | `EXPLORE_COLLECTION_NOT_FOUND`  | Index the codebase first with `index_codebase`                            |
| **Collection or path not provided** | `INPUT_COLLECTION_NOT_PROVIDED` | Provide a `collection` name or a `path` to the codebase                   |
| **Hybrid search not enabled**       | `EXPLORE_HYBRID_NOT_ENABLED`    | Re-run `index_codebase` — hybrid is enabled by default and auto-migrates  |
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

## Project Registry Issues

| Issue                                                    | Error Code                       | Solution                                                                                                                                                                                                                                          |
| -------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`registry.json` corrupt or unsupported version**       | `INFRA_REGISTRY_FILE_CORRUPTED`  | The old file is preserved at `registry.json.corrupt-<ISO>.bak`; tea-rags continues with an empty in-memory map. Run `tea-rags doctor --recover-registry` to repopulate stubs from live Qdrant state.                                              |
| **Atomic write of `registry.json` failed**               | `INFRA_REGISTRY_WRITE_FAILED`    | Check disk space and write permissions on `$TEA_RAGS_DATA_DIR` (default `~/.tea-rags/`). Retry — non-fatal for indexing, the pipeline logs and continues.                                                                                         |
| **Concurrent registry writers exhausted CAS budget**     | `INFRA_REGISTRY_CONCURRENCY`     | 5 CAS attempts with exponential backoff (10ms → 160ms) failed. Sustained contention from parallel tea-rags processes — check for runaway processes (`ps aux \| grep tea-rags`). Retrying usually resolves transient cases.                        |
| **Project name not unique (infra defensive check)**      | `INFRA_REGISTRY_NAME_CONFLICT`   | The user-facing surface is `INPUT_PROJECT_NAME_NOT_UNIQUE` (the api layer validates first); this infra-level error only fires when a caller bypasses the api. Choose a different name, or `tea-rags projects unregister --name <alias>` first.    |
| **Project alias has empty path (recovered stub)**        | `INPUT_PROJECT_PATH_MISSING`     | Registry entry exists for the alias but its `path` is empty — typical for stubs produced by `tea-rags doctor --recover-registry`. Re-register: `tea-rags projects register --path <dir> --name <alias>`.                                          |
| **Project alias unknown**                                | `INPUT_PROJECT_NOT_REGISTERED`   | The `--project` flag or MCP `project` parameter referenced a name not in the registry. Run `tea-rags projects list` to see registered aliases, or `tea-rags projects register --path <dir> --name <alias>` to add one.                            |

See **[Project Registry](/usage/advanced/project-registry)** for the full
guide, including the doctor command and orphan-collection workflows.

## Configuration Issues

| Issue                       | Error Code             | Solution                              |
| --------------------------- | ---------------------- | ------------------------------------- |
| **Invalid config value**    | `CONFIG_VALUE_INVALID` | Check expected values for the field   |
| **Required config missing** | `CONFIG_VALUE_MISSING` | Set the required environment variable |

---

## Update Check Issues

`tea-rags update` and the `## tea-rags package` section of `tea-rags prime` share the same update-check pipeline. Failures are non-fatal — they surface as exit codes or as an omitted prime section.

| Issue                                       | Symptom                                                                                 | Solution                                                                                                                                                                                                                                                  |
| ------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`tea-rags update` exits 1**               | `Couldn't check for updates (reason: network/timeout/malformed)`                        | Registry unreachable, DNS failure, or response not parseable. Retry; check `curl https://registry.npmjs.org/tea-rags/latest`. A 5-min negative cache is written so repeats are cheap.                                                                       |
| **`tea-rags update` exits 127**             | `npm not found in PATH. Install Node.js or update tea-rags manually.`                   | `npm` binary missing. Reinstall Node.js or add `npm` to `PATH`. The command never falls back to `pnpm`/`yarn`/`bun` — invoke them yourself: `pnpm add -g tea-rags@latest`, `yarn global add tea-rags@latest`, `bun add -g tea-rags@latest`.                  |
| **postinstall doesn't run on update**       | After `tea-rags update`, native binaries or setup hooks weren't refreshed               | tea-rags forces `npm_config_ignore_scripts=false` in the spawn env, so even a user-level `ignore-scripts=true` in `~/.npmrc` is overridden. If postinstall still doesn't run, check the npm exit code in your terminal output — a non-zero code is forwarded. |
| **`EACCES` during `npm install -g`**        | Permission denied writing to global prefix                                              | Either use `sudo npm install -g tea-rags@latest` once, or set a user-writable prefix: `npm config set prefix ~/.npm-global` then add `~/.npm-global/bin` to `PATH`. Then re-run `tea-rags update`.                                                          |
| **prime never shows the package section**   | Even when you know a newer version exists                                               | Cache may be stuck on an old "up-to-date" response. Delete `~/.tea-rags/update-check.json` to force a fresh fetch on next prime.                                                                                                                            |
| **prime hangs on update check**             | Digest takes >2s to render                                                              | The HTTP call has a 1.5s timeout running in parallel with Qdrant queries. If it consistently times out, the negative cache (5min) skips the check entirely on subsequent runs. Confirm registry reachability outside tea-rags.                              |
| **Corrupt cache JSON**                      | No symptom — self-heals                                                                  | If `~/.tea-rags/update-check.json` becomes unparseable or has a wrong schema, the next read deletes it and returns null. Next prime/update re-fetches and rewrites.                                                                                          |
| **Downgrade scenario (installed > latest)** | prime stays silent; `tea-rags update` reports `is up to date`                            | By design — when installed semver is **greater** than registry latest (e.g. testing a pre-release locally), the status is `up-to-date`. No downgrade is offered.                                                                                            |

---

## Error Codes Reference

Full table of all structured error codes returned by the MCP server.

| Code                                   | Class                        | HTTP | Message Template                                               | Hint Template                                                          |
| -------------------------------------- | ---------------------------- | ---- | -------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `UNKNOWN_ERROR`                        | `UnknownError`               | 500  | Unexpected error: `{detail}`                                   | Check server logs for details                                          |
| `INPUT_COLLECTION_NOT_PROVIDED`        | `CollectionNotProvidedError` | 400  | Either 'collection' or 'path' parameter is required.           | Provide a 'collection' name or a 'path' to the codebase.               |
| `INFRA_QDRANT_UNAVAILABLE`             | `QdrantUnavailableError`     | 503  | Qdrant is not reachable at `{url}`                             | Start Qdrant: `docker compose up -d`, or verify `QDRANT_URL={url}`     |
| `INFRA_QDRANT_TIMEOUT`                 | `QdrantTimeoutError`         | 504  | Qdrant operation "`{operation}`" timed out at `{url}`          | Check Qdrant server load or increase timeout                           |
| `INFRA_QDRANT_OPERATION`               | `QdrantOperationError`       | 500  | Qdrant operation "`{operation}`" failed: `{detail}`            | Check Qdrant logs for details                                          |
| `INFRA_EMBEDDING_OLLAMA_UNAVAILABLE`   | `OllamaUnavailableError`     | 503  | Ollama is not reachable at `{url}`                             | Start Ollama or verify `OLLAMA_BASE_URL={url}`                         |
| `INFRA_EMBEDDING_OLLAMA_MODEL_MISSING` | `OllamaModelMissingError`    | 503  | Model "`{model}`" is not available on Ollama at `{url}`        | Pull the model: `ollama pull {model}`                                  |
| `INFRA_EMBEDDING_ONNX_LOAD`            | `OnnxModelLoadError`         | 503  | Failed to load ONNX model from "`{modelPath}`"                 | Check that the model file exists and is valid                          |
| `INFRA_EMBEDDING_ONNX_INFERENCE`       | `OnnxInferenceError`         | 500  | ONNX inference failed: `{detail}`                              | Check model compatibility and input data                               |
| `INFRA_EMBEDDING_OPENAI_RATE_LIMIT`    | `OpenAIRateLimitError`       | 429  | OpenAI API rate limit exceeded                                 | Wait and retry, or increase rate limits                                |
| `INFRA_EMBEDDING_OPENAI_AUTH`          | `OpenAIAuthError`            | 401  | OpenAI API authentication failed                               | Check `OPENAI_API_KEY` is set correctly                                |
| `INFRA_EMBEDDING_COHERE_RATE_LIMIT`    | `CohereRateLimitError`       | 429  | Cohere API rate limit exceeded                                 | Wait and retry                                                         |
| `INFRA_EMBEDDING_VOYAGE_RATE_LIMIT`    | `VoyageRateLimitError`       | 429  | Voyage API rate limit exceeded                                 | Wait and retry                                                         |
| `INFRA_GIT_NOT_FOUND`                  | `GitCliNotFoundError`        | 503  | Git CLI is not installed                                       | Install git                                                            |
| `INFRA_GIT_TIMEOUT`                    | `GitCliTimeoutError`         | 504  | Git command "`{command}`" timed out after `{timeoutMs}`ms      | Reduce scope or increase timeout                                       |
| `INFRA_ALIAS_OPERATION`                | `AliasOperationError`        | 500  | Alias operation "`{operation}`" failed: `{detail}`             | Check Qdrant server status and collection names                        |
| `INGEST_NOT_INDEXED`                   | `NotIndexedError`            | 404  | Codebase at "`{path}`" is not indexed                          | Run `index_codebase` first                                             |
| `INGEST_COLLECTION_EXISTS`             | `CollectionExistsError`      | 409  | Collection "`{collectionName}`" already exists                 | Use `forceReindex=true` or delete first                                |
| `INGEST_SNAPSHOT_MISSING`              | `SnapshotMissingError`       | 404  | Snapshot not found at "`{path}`"                               | Ensure the snapshot file exists                                        |
| `INGEST_SNAPSHOT_CORRUPTED`            | `SnapshotCorruptedError`     | 400  | Snapshot corrupted: `{detail}`                                 | Delete and re-index with `forceReindex=true`                           |
| `INGEST_MIGRATION_FAILED`              | `MigrationFailedError`       | 400  | Snapshot migration failed: `{reason}`                          | Delete old snapshot and re-index                                       |
| `INGEST_FILE_READ_FAILED`              | `FileReadError`              | 400  | Failed to read "`{path}`": `{detail}`                          | Quarantined + auto-retried - see [Quarantine](/operations/quarantine)  |
| `INGEST_FILE_PARSE_FAILED`             | `FileParseError`             | 400  | Failed to parse "`{path}`": `{detail}`                         | Quarantined + auto-retried - see [Quarantine](/operations/quarantine)  |
| `INGEST_CHUNK_OVERSIZED`               | `ChunkOversizedError`        | 400  | Chunk in "`{path}`" oversized: `{detail}`                      | Lower `INGEST_CHUNK_SIZE` - see [Quarantine](/operations/quarantine)   |
| `INGEST_EMBEDDING_REJECTED`            | `EmbeddingRejectedError`     | 400  | Embedding rejected for "`{path}`": `{detail}`                  | Quarantined + auto-retried - see [Quarantine](/operations/quarantine)  |
| `EXPLORE_COLLECTION_NOT_FOUND`         | `CollectionNotFoundError`    | 404  | Collection "`{collectionName}`" does not exist                 | Index the codebase first                                               |
| `EXPLORE_HYBRID_NOT_ENABLED`           | `HybridNotEnabledError`      | 400  | Collection "`{collectionName}`" does not support hybrid search | Re-run `index_codebase` — hybrid is enabled by default and auto-migrates |
| `EXPLORE_INVALID_QUERY`                | `InvalidQueryError`          | 400  | Invalid query: `{reason}`                                      | Fix query parameters                                                   |
| `TRAJECTORY_GIT_BLAME_FAILED`          | `GitBlameFailedError`        | 500  | Git blame failed for "`{file}`"                                | Ensure file is tracked by git                                          |
| `TRAJECTORY_GIT_LOG_TIMEOUT`           | `GitLogTimeoutError`         | 504  | Git log timed out after `{timeoutMs}`ms                        | Reduce scope or increase timeout                                       |
| `TRAJECTORY_GIT_NOT_AVAILABLE`         | `GitNotAvailableError`       | 503  | Git is not available                                           | Ensure git is installed and in PATH                                    |
| `TRAJECTORY_STATIC_PARSE_FAILED`       | `StaticParseFailedError`     | 500  | Failed to parse "`{file}`"                                     | File may have syntax errors                                            |
| `CONFIG_VALUE_INVALID`                 | `ConfigValueInvalidError`    | 400  | Invalid value "`{value}`" for field "`{field}`"                | Expected one of: `{expected}`                                          |
| `CONFIG_VALUE_MISSING`                 | `ConfigValueMissingError`    | 400  | Required field "`{field}`" is not set                          | Set the `{envVar}` environment variable                                |
| `INFRA_REGISTRY_FILE_CORRUPTED`        | `RegistryFileCorruptedError` | 500  | Registry file at "`{path}`" is corrupted: `{reason}`           | Delete the file and re-run indexing, or run `tea-rags doctor` to regenerate from Qdrant |
| `INFRA_REGISTRY_WRITE_FAILED`          | `RegistryWriteError`         | 500  | Failed to write registry file at "`{path}`"                    | Check disk space and write permissions on the data directory          |
| `INFRA_REGISTRY_CONCURRENCY`           | `RegistryConcurrencyError`   | 503  | Registry file at "`{path}`" was modified concurrently across `{attempts}` attempts | Retry the operation; if it persists, check for runaway tea-rags processes |
| `INFRA_REGISTRY_NAME_CONFLICT`         | `RegistryNameConflictError`  | 409  | Project name "`{name}`" is not unique — already used by "`{existingCollectionName}`" | Pre-validate via `findByName` before `setName`, or surface as 409 to the user |
| `INPUT_PROJECT_NOT_REGISTERED`         | `ProjectNotRegisteredError`  | 400  | Project "`{name}`" is not registered. Available: `{list}`      | Register the project via `index_codebase`, or pick a name from the available list |
| `INPUT_PROJECT_NAME_NOT_UNIQUE`        | `ProjectNameNotUniqueError`  | 400  | Project name "`{name}`" is not unique — already used by "`{existingCollectionName}`" | Choose a different name or remove the existing project                |
| `INPUT_PROJECT_NAME_INVALID`           | `ProjectNameInvalidError`    | 400  | Project name "`{name}`" is invalid: `{reasonPhrase}`           | Names must be non-empty, within length limits, and match the allowed character set |
| `INPUT_PATH_NOT_EXISTS`                | `PathDoesNotExistError`      | 400  | Path "`{path}`" does not exist                                 | Provide an absolute path to an existing directory                     |
| `INPUT_PROJECT_PATH_MISSING`           | `ProjectPathMissingError`    | 400  | Project "`{name}`" has no path stored — re-register it before using as an alias | Run `tea-rags projects register --path <dir> --name <alias>`          |

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
