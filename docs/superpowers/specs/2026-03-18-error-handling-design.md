# Unified Error Handling Design

> **Status:** Approved (brainstorming) **Date:** 2026-03-18

**Goal:** Standardized error hierarchy with human-readable messages, graceful
startup when dependencies are down, and documented error codes.

**Architecture:** Every error is a concrete class inheriting from domain-level
base classes. Errors bubble from adapters through facades to MCP tool handlers,
where a single wrapper formats them for the client. Server never crashes due to
unavailable Qdrant/Ollama.

---

## 1. Error Contract

**File:** `src/core/contracts/errors.ts`

```typescript
interface TeaRagsErrorContract {
  readonly code: string; // "INFRA_QDRANT_UNAVAILABLE"
  readonly message: string; // "Qdrant is not reachable at http://localhost:6333"
  readonly hint: string; // "Start Qdrant: docker compose up -d"
  readonly httpStatus: number; // 503
  readonly cause?: Error; // original error
}
```

### Fields

| Field        | Purpose                                                     |
| ------------ | ----------------------------------------------------------- |
| `code`       | Machine-readable, categorized: `DOMAIN_SPECIFIC_ERROR`      |
| `message`    | Human-readable description with context (URLs, model names) |
| `hint`       | Actionable fix instruction for the user                     |
| `httpStatus` | HTTP status for HTTP transport responses                    |
| `cause`      | Original error for debugging (fetch failures, etc.)         |

### Methods

| Method            | Output                         | Used by            |
| ----------------- | ------------------------------ | ------------------ |
| `toUserMessage()` | `[CODE] message\n\nHint: hint` | MCP tool responses |
| `toString()`      | `ClassName [CODE]: message`    | Logs, debugging    |

---

## 2. Error Hierarchy

```
TeaRagsError (base)                          src/core/infra/errors.ts
  ├─ InfraError                              src/core/adapters/errors.ts
  │   ├─ QdrantUnavailableError              src/core/adapters/qdrant/errors.ts
  │   ├─ QdrantTimeoutError                  src/core/adapters/qdrant/errors.ts
  │   ├─ EmbeddingFailedError                src/core/adapters/embeddings/errors.ts
  │   ├─ OllamaUnavailableError              src/core/adapters/embeddings/ollama/errors.ts
  │   ├─ OllamaModelMissingError             src/core/adapters/embeddings/ollama/errors.ts
  │   ├─ OnnxModelLoadError                  src/core/adapters/embeddings/onnx/errors.ts
  │   ├─ OnnxInferenceError                  src/core/adapters/embeddings/onnx/errors.ts
  │   ├─ OpenAIRateLimitError                src/core/adapters/embeddings/openai/errors.ts
  │   ├─ OpenAIAuthError                     src/core/adapters/embeddings/openai/errors.ts
  │   ├─ CohereRateLimitError                src/core/adapters/embeddings/cohere/errors.ts
  │   └─ VoyageRateLimitError                src/core/adapters/embeddings/voyage/errors.ts
  ├─ IngestError                             src/core/domains/ingest/errors.ts
  │   ├─ NotIndexedError
  │   ├─ CollectionExistsError
  │   └─ SnapshotMissingError
  ├─ ExploreError                            src/core/domains/explore/errors.ts
  │   ├─ CollectionNotFoundError
  │   ├─ HybridNotEnabledError
  │   └─ InvalidQueryError
  ├─ TrajectoryError                         src/core/domains/trajectory/errors.ts
  │   ├─ TrajectoryGitError                  src/core/domains/trajectory/git/errors.ts
  │   │   ├─ GitBlameFailedError
  │   │   ├─ GitLogTimeoutError
  │   │   └─ GitNotAvailableError
  │   └─ TrajectoryStaticError               src/core/domains/trajectory/static/errors.ts
  │       └─ StaticParseFailedError
  └─ ConfigError                             src/bootstrap/errors.ts
      ├─ InvalidConfigError
      └─ MissingConfigError
```

### Error Code Naming Convention

`DOMAIN_SPECIFIC_ERROR` — prefix is domain, suffix is problem.

```
INFRA_QDRANT_UNAVAILABLE
INFRA_OLLAMA_MODEL_MISSING
INGEST_NOT_INDEXED
EXPLORE_HYBRID_NOT_ENABLED
TRAJECTORY_GIT_BLAME_FAILED
CONFIG_INVALID
```

### Concrete Class Pattern

Each concrete class owns its parameters and constructs message/hint from them:

```typescript
class QdrantUnavailableError extends InfraError {
  constructor(url: string, cause?: Error) {
    super({
      code: "INFRA_QDRANT_UNAVAILABLE",
      message: `Qdrant is not reachable at ${url}`,
      hint: `Start Qdrant: docker compose up -d, or verify QDRANT_URL=${url}`,
      httpStatus: 503,
      cause,
    });
  }
}

class OllamaModelMissingError extends InfraError {
  constructor(model: string, url: string) {
    super({
      code: "INFRA_OLLAMA_MODEL_MISSING",
      message: `Model "${model}" is not available on Ollama at ${url}`,
      hint: `Pull the model: ollama pull ${model}`,
      httpStatus: 503,
    });
  }
}
```

### Default httpStatus by Domain

| Domain            | Default | Override examples               |
| ----------------- | ------- | ------------------------------- |
| `InfraError`      | 503     | —                               |
| `IngestError`     | 400     | `NotIndexedError` → 404         |
| `ExploreError`    | 400     | `CollectionNotFoundError` → 404 |
| `TrajectoryError` | 500     | `GitLogTimeoutError` → 504      |
| `ConfigError`     | 400     | —                               |
| Unknown errors    | 500     | —                               |

---

## 3. Graceful Startup

### Current behavior (broken)

```
main()
  ├─ checkOllamaAvailability()  ← CRASHES if Ollama down
  ├─ createAppContext()          ← CRASHES if embedded Qdrant fails
  └─ startServer()
```

### New behavior

```
main()
  ├─ parseAppConfig()           ← validates env vars (can still crash on bad config)
  ├─ createAppContext()          ← QdrantManager lazy-connects, no crash
  └─ startServer()              ← MCP server always starts
```

### Changes

1. **Remove `checkOllamaAvailability()` call** from `src/index.ts`
2. **Remove or deprecate** `src/bootstrap/ollama.ts` (function no longer needed)
3. **Adapters throw typed errors on first use** — Ollama adapter throws
   `OllamaUnavailableError` when `embedBatch()` fails to connect; Qdrant adapter
   throws `QdrantUnavailableError` when first operation fails
4. **No pre-flight health checks** — errors discovered naturally at runtime

### Error propagation path

```
Adapter (e.g. ollama.ts)     → throw new OllamaUnavailableError(url, fetchError)
  ↓ bubbles through
Facade / Pipeline            → does not catch, propagates
  ↓ bubbles through
App method                   → does not catch, propagates
  ↓ caught by
MCP tool wrapper             → withErrorHandling() catches, formats response
  ↓ returned to
MCP client                   → sees [CODE] message + Hint
```

---

## 4. MCP Error Handling Wrapper

### `withErrorHandling()`

**File:** `src/mcp/format.ts`

Wraps every MCP tool handler. Removes duplicated try/catch from individual
tools.

```typescript
function withErrorHandling(handler: ToolHandler): ToolHandler {
  return async (params) => {
    try {
      return await handler(params);
    } catch (e) {
      if (e instanceof TeaRagsError) {
        return {
          content: [{ type: "text", text: e.toUserMessage() }],
          isError: true,
        };
      }
      // Unknown error — fallback
      const message = e instanceof Error ? e.message : String(e);
      return {
        content: [
          {
            type: "text",
            text: `[UNKNOWN_ERROR] ${message}\n\nHint: Check server logs for details`,
          },
        ],
        isError: true,
      };
    }
  };
}
```

### Registration pattern

```typescript
// Before (duplicated try/catch in every handler):
server.registerTool("semantic_search", schema, async (params) => {
  try {
    const result = await app.semanticSearch(params);
    return formatResult(result);
  } catch (error) {
    return formatMcpError(error.message);
  }
});

// After (clean handlers, centralized error handling):
server.registerTool(
  "semantic_search",
  schema,
  withErrorHandling(async (params) => {
    const result = await app.semanticSearch(params);
    return formatResult(result);
  }),
);
```

### HTTP transport

For HTTP mode, `httpStatus` from `TeaRagsError` is used as response status code.
Unknown errors return 500.

---

## 5. MCP Response Format

### TeaRagsError response

```json
{
  "content": [
    {
      "type": "text",
      "text": "[INFRA_QDRANT_UNAVAILABLE] Qdrant is not reachable at http://localhost:6333\n\nHint: Start Qdrant: docker compose up -d, or verify QDRANT_URL=http://localhost:6333"
    }
  ],
  "isError": true
}
```

### Unknown error response

```json
{
  "content": [
    {
      "type": "text",
      "text": "[UNKNOWN_ERROR] Unexpected error: connection reset\n\nHint: Check server logs for details"
    }
  ],
  "isError": true
}
```

### Format: `[CODE] message\n\nHint: hint`

- Agent sees `CODE` for programmatic decisions
- User sees human-readable message and actionable hint
- Same format for stdio and HTTP transports

---

## 6. Documentation Updates

### `website/docs/operations/troubleshooting.md`

Rename to `troubleshooting-and-error-codes.md`. Changes:

1. Break existing fix tables by error domain (Infrastructure, Indexing, Search,
   Trajectory, Configuration)
2. Add error code column to each table
3. Add "Error Codes Reference" section with full table of all codes, messages,
   hints, httpStatus

### search-cascade update

Update the session-start rule:

1. `get_index_status` ALWAYS called at session start (no change)
2. If response contains `TeaRagsError` format → agent shows hint to user, asks
   to fix (e.g. "start Ollama"), then retries
3. If not indexed → `index_codebase` (no change)
4. Reconnect MCP server only if config change is needed

---

## 7. Migration of Existing Errors

Replace scattered error classes with new hierarchy:

| Current                                        | Location                                          | New class                 |
| ---------------------------------------------- | ------------------------------------------------- | ------------------------- |
| `CollectionRefError`                           | `src/core/infra/collection-name.ts`               | `InvalidQueryError`       |
| `CollectionNotFoundError`                      | `src/core/api/internal/facades/explore-facade.ts` | `CollectionNotFoundError` |
| `HybridNotEnabledError`                        | `src/core/domains/explore/strategies/types.ts`    | `HybridNotEnabledError`   |
| `throw new Error("Codebase not indexed")`      | `src/core/domains/ingest/reindexing.ts`           | `NotIndexedError`         |
| `throw new Error("No previous snapshot")`      | `src/core/domains/ingest/reindexing.ts`           | `SnapshotMissingError`    |
| `throw new Error("Collection already exists")` | `src/core/domains/ingest/indexing.ts`             | `CollectionExistsError`   |
| Ollama fetch failures                          | `src/core/adapters/embeddings/ollama.ts`          | `OllamaUnavailableError`  |
| Qdrant operation failures                      | `src/core/adapters/qdrant/client.ts`              | `QdrantUnavailableError`  |

---

## 8. File Summary

### New files

| File                                            | Contents                                                                                  |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `src/core/contracts/errors.ts`                  | `TeaRagsErrorContract` interface, `ErrorCode` type union                                  |
| `src/core/infra/errors.ts`                      | `TeaRagsError` base class                                                                 |
| `src/core/adapters/errors.ts`                   | `InfraError` base class                                                                   |
| `src/core/adapters/qdrant/errors.ts`            | `QdrantUnavailableError`, `QdrantTimeoutError`                                            |
| `src/core/adapters/embeddings/errors.ts`        | `EmbeddingFailedError` base class                                                         |
| `src/core/adapters/embeddings/ollama/errors.ts` | `OllamaUnavailableError`, `OllamaModelMissingError`                                       |
| `src/core/adapters/embeddings/onnx/errors.ts`   | `OnnxModelLoadError`, `OnnxInferenceError`                                                |
| `src/core/adapters/embeddings/openai/errors.ts` | `OpenAIRateLimitError`, `OpenAIAuthError`                                                 |
| `src/core/adapters/embeddings/cohere/errors.ts` | `CohereRateLimitError`                                                                    |
| `src/core/adapters/embeddings/voyage/errors.ts` | `VoyageRateLimitError`                                                                    |
| `src/core/domains/ingest/errors.ts`             | `IngestError`, `NotIndexedError`, `CollectionExistsError`, `SnapshotMissingError`         |
| `src/core/domains/explore/errors.ts`            | `ExploreError`, `CollectionNotFoundError`, `HybridNotEnabledError`, `InvalidQueryError`   |
| `src/core/domains/trajectory/errors.ts`         | `TrajectoryError`                                                                         |
| `src/core/domains/trajectory/git/errors.ts`     | `TrajectoryGitError`, `GitBlameFailedError`, `GitLogTimeoutError`, `GitNotAvailableError` |
| `src/core/domains/trajectory/static/errors.ts`  | `TrajectoryStaticError`, `StaticParseFailedError`                                         |
| `src/bootstrap/errors.ts`                       | `ConfigError`, `InvalidConfigError`, `MissingConfigError`                                 |

### Modified files

| File                                              | Change                                                           |
| ------------------------------------------------- | ---------------------------------------------------------------- |
| `src/index.ts`                                    | Remove `checkOllamaAvailability()` call                          |
| `src/mcp/format.ts`                               | Add `withErrorHandling()`, keep `formatMcpError()` as deprecated |
| `src/mcp/tools/code.ts`                           | Wrap handlers with `withErrorHandling()`, remove try/catch       |
| `src/mcp/tools/explore.ts`                        | Same                                                             |
| `src/mcp/tools/collection.ts`                     | Same                                                             |
| `src/core/adapters/embeddings/ollama.ts`          | Throw `OllamaUnavailableError` / `OllamaModelMissingError`       |
| `src/core/adapters/embeddings/onnx.ts`            | Throw `OnnxModelLoadError` / `OnnxInferenceError`                |
| `src/core/adapters/embeddings/openai.ts`          | Throw `OpenAIRateLimitError` / `OpenAIAuthError`                 |
| `src/core/adapters/embeddings/cohere.ts`          | Throw `CohereRateLimitError`                                     |
| `src/core/adapters/embeddings/voyage.ts`          | Throw `VoyageRateLimitError`                                     |
| `src/core/adapters/qdrant/client.ts`              | Throw `QdrantUnavailableError` / `QdrantTimeoutError`            |
| `src/core/domains/ingest/reindexing.ts`           | Use `NotIndexedError`, `SnapshotMissingError`                    |
| `src/core/domains/ingest/indexing.ts`             | Use `CollectionExistsError`                                      |
| `src/core/domains/explore/strategies/types.ts`    | Remove old `HybridNotEnabledError`, use new one                  |
| `src/core/api/internal/facades/explore-facade.ts` | Remove old `CollectionNotFoundError`, use new one                |
| `src/core/infra/collection-name.ts`               | Remove old `CollectionRefError`, use `InvalidQueryError`         |
| `website/docs/operations/troubleshooting.md`      | Rename + add error codes reference                               |
