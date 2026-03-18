# Unified Error Handling Design

> **Status:** Approved **Date:** 2026-03-18

**Goal:** Standardized error hierarchy with human-readable messages, graceful
startup when dependencies are down, and documented error codes.

**Architecture:** Every error is a concrete class inheriting from domain-level
abstract base classes. Adapters catch raw errors and throw typed errors. MCP
middleware is the single catch-all — formats `TeaRagsError` via
`toUserMessage()`, wraps unknown errors in `UnknownError`. Server never crashes
due to unavailable Qdrant/Ollama.

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

`toUserMessage()` is overridable by subclasses for custom formatting.

---

## 2. Error Hierarchy

All base classes are `abstract` — cannot be instantiated directly. Only concrete
leaf classes are thrown.

```
abstract TeaRagsError (base)                     src/core/infra/errors.ts
  ├─ UnknownError                                src/core/infra/errors.ts
  ├─ abstract InputValidationError               src/core/api/errors.ts
  │   └─ CollectionNotProvidedError
  ├─ abstract InfraError                         src/core/adapters/errors.ts
  │   ├─ QdrantUnavailableError                  src/core/adapters/qdrant/errors.ts
  │   ├─ QdrantTimeoutError                      src/core/adapters/qdrant/errors.ts
  │   ├─ QdrantOperationError                    src/core/adapters/qdrant/errors.ts
  │   ├─ abstract EmbeddingError                 src/core/adapters/embeddings/errors.ts
  │   │   ├─ OllamaUnavailableError              src/core/adapters/embeddings/ollama/errors.ts
  │   │   ├─ OllamaModelMissingError             src/core/adapters/embeddings/ollama/errors.ts
  │   │   ├─ OnnxModelLoadError                  src/core/adapters/embeddings/onnx/errors.ts
  │   │   ├─ OnnxInferenceError                  src/core/adapters/embeddings/onnx/errors.ts
  │   │   ├─ OpenAIRateLimitError                src/core/adapters/embeddings/openai/errors.ts
  │   │   ├─ OpenAIAuthError                     src/core/adapters/embeddings/openai/errors.ts
  │   │   ├─ CohereRateLimitError                src/core/adapters/embeddings/cohere/errors.ts
  │   │   └─ VoyageRateLimitError                src/core/adapters/embeddings/voyage/errors.ts
  │   ├─ GitCliNotFoundError                     src/core/adapters/git/errors.ts
  │   └─ GitCliTimeoutError                      src/core/adapters/git/errors.ts
  ├─ abstract IngestError                        src/core/domains/ingest/errors.ts
  │   ├─ NotIndexedError
  │   ├─ CollectionExistsError
  │   └─ SnapshotMissingError
  ├─ abstract ExploreError                       src/core/domains/explore/errors.ts
  │   ├─ CollectionNotFoundError
  │   ├─ HybridNotEnabledError
  │   └─ InvalidQueryError
  ├─ abstract TrajectoryError                    src/core/domains/trajectory/errors.ts
  │   ├─ abstract TrajectoryGitError             src/core/domains/trajectory/git/errors.ts
  │   │   ├─ GitBlameFailedError
  │   │   ├─ GitLogTimeoutError
  │   │   └─ GitNotAvailableError
  │   └─ abstract TrajectoryStaticError          src/core/domains/trajectory/static/errors.ts
  │       └─ StaticParseFailedError
  └─ abstract ConfigError                        src/bootstrap/errors.ts
      ├─ ConfigValueInvalidError
      └─ ConfigValueMissingError
```

### Error responsibilities per layer

- **Adapters** — catch raw errors (fetch, qdrant client, git CLI), throw typed
  errors. Include messages from external APIs in `message`.
- **Domains/Facades** — catch domain-specific issues, throw typed errors. Input
  validation (`CollectionNotProvidedError`) in facades before calling infra.
- **MCP middleware** — single catch-all. `TeaRagsError` → `toUserMessage()`.
  Unknown errors → `new UnknownError(e)` → same format.

### Error Code Naming Convention

`DOMAIN_SPECIFIC_ERROR` — prefix is domain, suffix is problem.

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

| Domain                 | Default | Override examples               |
| ---------------------- | ------- | ------------------------------- |
| `InfraError`           | 503     | `QdrantOperationError` → 500    |
| `InputValidationError` | 400     | —                               |
| `IngestError`          | 400     | `NotIndexedError` → 404         |
| `ExploreError`         | 400     | `CollectionNotFoundError` → 404 |
| `TrajectoryError`      | 500     | `GitLogTimeoutError` → 504      |
| `ConfigError`          | 400     | —                               |
| `UnknownError`         | 500     | —                               |

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

1. **Delete `checkOllamaAvailability()` call** from `src/index.ts`
2. **Delete `src/bootstrap/ollama.ts`** — function no longer needed; errors are
   thrown by adapters at runtime on first use
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
MCP middleware                → formats via toUserMessage()
  ↓ returned to
MCP client                   → sees [CODE] message + Hint
```

---

## 4. MCP Error Middleware

**File:** `src/mcp/middleware/error-handler.ts`

Single catch-all middleware wrapping all MCP tool handlers. No tool file
contains try/catch — all error handling is centralized here.

```typescript
function errorHandlerMiddleware<T>(
  handler: (args: T, extra: RequestHandlerExtra) => Promise<McpToolResult>,
): (args: T, extra: RequestHandlerExtra) => Promise<McpToolResult> {
  return async (args, extra) => {
    try {
      return await handler(args, extra);
    } catch (e) {
      // Log full error with cause chain to stderr for debugging
      console.error(`[MCP] Tool error:`, e);

      if (e instanceof TeaRagsError) {
        return {
          content: [{ type: "text", text: e.toUserMessage() }],
          isError: true,
        };
      }
      // Unknown error — wrap in UnknownError for consistent format
      const unknown = new UnknownError(e);
      return {
        content: [{ type: "text", text: unknown.toUserMessage() }],
        isError: true,
      };
    }
  };
}
```

HTTP transport uses `httpStatus` from the error as response status code.

### Middleware wiring

A helper function `registerToolSafe` applies the middleware automatically:

```typescript
function registerToolSafe(
  server: McpServer,
  name: string,
  metadata: ToolMetadata,
  handler: ToolHandler,
): void {
  server.registerTool(name, metadata, errorHandlerMiddleware(handler));
}
```

All tool registration files (`code.ts`, `explore.ts`, `collection.ts`,
`document.ts`) use `registerToolSafe` instead of `server.registerTool` directly.
No tool file contains try/catch.

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

1. Break existing fix tables by error domain (Infrastructure, Indexing, Explore,
   Trajectory, Configuration)
2. Add error code column to each table
3. Add "Error Codes Reference" section with full table of all codes, messages,
   hints, httpStatus

### search-cascade update

Update the session-start rule:

1. `get_index_status` ALWAYS called at session start (no change)
2. If response contains error format → agent reads `code` and `hint`, proposes
   concrete fix to user (e.g. "Qdrant is not running. Run
   `docker compose up -d`?"), executes after confirmation
3. If not indexed → `index_codebase` (no change)
4. Reconnect MCP server only if config change is needed

---

## 7. Migration of Existing Errors

Replace scattered error classes with new hierarchy:

| Current                                        | Location                                          | New class                    |
| ---------------------------------------------- | ------------------------------------------------- | ---------------------------- |
| `CollectionRefError`                           | `src/core/infra/collection-name.ts`               | `CollectionNotProvidedError` |
| `CollectionNotFoundError`                      | `src/core/api/internal/facades/explore-facade.ts` | `CollectionNotFoundError`    |
| `HybridNotEnabledError`                        | `src/core/domains/explore/strategies/types.ts`    | `HybridNotEnabledError`      |
| `throw new Error("Codebase not indexed")`      | `src/core/domains/ingest/reindexing.ts`           | `NotIndexedError`            |
| `throw new Error("No previous snapshot")`      | `src/core/domains/ingest/reindexing.ts`           | `SnapshotMissingError`       |
| `throw new Error("Collection already exists")` | `src/core/domains/ingest/indexing.ts`             | `CollectionExistsError`      |
| Ollama fetch failures                          | `src/core/adapters/embeddings/ollama.ts`          | `OllamaUnavailableError`     |
| Qdrant connection failures                     | `src/core/adapters/qdrant/client.ts`              | `QdrantUnavailableError`     |
| Qdrant operation failures                      | `src/core/adapters/qdrant/client.ts`              | `QdrantOperationError`       |
| Missing API keys in factory                    | `src/core/adapters/embeddings/factory.ts`         | `ConfigValueMissingError`    |
| Unknown provider in factory                    | `src/core/adapters/embeddings/factory.ts`         | `ConfigValueInvalidError`    |

### Additional explore facade throw sites

| Current throw                                           | New class                            |
| ------------------------------------------------------- | ------------------------------------ |
| `"Strategy requires at least one positive input"`       | `InvalidQueryError`                  |
| `"At least one positive or negative input is required"` | `InvalidQueryError`                  |
| `"Collection not found. Index the codebase first."`     | `CollectionNotFoundError`            |
| `"No statistics available. Re-index the codebase."`     | `NotIndexedError` (from IngestError) |

### Intentionally excluded (programming errors)

These `throw new Error(...)` sites are **programming errors** (invariant
violations), not user-facing errors. They are intentionally left as plain
`Error` — the MCP middleware catches them as `UnknownError`.

| Location                               | Message                            | Why excluded          |
| -------------------------------------- | ---------------------------------- | --------------------- |
| `sync/consistent-hash.ts:22`           | `"Shard count must be at least 1"` | Constructor invariant |
| `pipeline/pipeline-manager.ts:116,150` | `"Pipeline not started"`           | Caller bug            |
| `pipeline/chunk-pipeline.ts:151`       | `"ChunkPipeline not started"`      | Caller bug            |

Validation `!collection && !path` moves from `resolveCollection()` (infra) to
facades (api layer). `CollectionRefError` is deleted from infra, replaced by
`CollectionNotProvidedError` thrown from facades.

---

## 8. File Summary

### New files

| File                                            | Contents                                                                                           |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `src/core/contracts/errors.ts`                  | `TeaRagsErrorContract` interface, `ErrorCode` type union                                           |
| `src/core/infra/errors.ts`                      | `abstract TeaRagsError` base class, `UnknownError`                                                 |
| `src/core/api/errors.ts`                        | `abstract InputValidationError`, `CollectionNotProvidedError`                                      |
| `src/core/adapters/errors.ts`                   | `abstract InfraError`                                                                              |
| `src/core/adapters/qdrant/errors.ts`            | `QdrantUnavailableError`, `QdrantTimeoutError`, `QdrantOperationError`                             |
| `src/core/adapters/embeddings/errors.ts`        | `abstract EmbeddingError` (never thrown directly)                                                  |
| `src/core/adapters/embeddings/ollama/errors.ts` | `OllamaUnavailableError`, `OllamaModelMissingError`                                                |
| `src/core/adapters/embeddings/onnx/errors.ts`   | `OnnxModelLoadError`, `OnnxInferenceError`                                                         |
| `src/core/adapters/embeddings/openai/errors.ts` | `OpenAIRateLimitError`, `OpenAIAuthError`                                                          |
| `src/core/adapters/embeddings/cohere/errors.ts` | `CohereRateLimitError`                                                                             |
| `src/core/adapters/embeddings/voyage/errors.ts` | `VoyageRateLimitError`                                                                             |
| `src/core/adapters/git/errors.ts`               | `GitCliNotFoundError`, `GitCliTimeoutError`                                                        |
| `src/core/domains/ingest/errors.ts`             | `abstract IngestError`, `NotIndexedError`, `CollectionExistsError`, `SnapshotMissingError`         |
| `src/core/domains/explore/errors.ts`            | `abstract ExploreError`, `CollectionNotFoundError`, `HybridNotEnabledError`, `InvalidQueryError`   |
| `src/core/domains/trajectory/errors.ts`         | `abstract TrajectoryError`                                                                         |
| `src/core/domains/trajectory/git/errors.ts`     | `abstract TrajectoryGitError`, `GitBlameFailedError`, `GitLogTimeoutError`, `GitNotAvailableError` |
| `src/core/domains/trajectory/static/errors.ts`  | `abstract TrajectoryStaticError`, `StaticParseFailedError`                                         |
| `src/bootstrap/errors.ts`                       | `abstract ConfigError`, `ConfigValueInvalidError`, `ConfigValueMissingError`                       |
| `src/mcp/middleware/error-handler.ts`           | `errorHandlerMiddleware()`, `registerToolSafe()`                                                   |
| `.claude/rules/typed-errors.md`                 | Mandatory typed errors rule                                                                        |

### Modified files

| File                                                         | Change                                                                    |
| ------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `src/index.ts`                                               | Remove `checkOllamaAvailability()` call                                   |
| `src/bootstrap/ollama.ts`                                    | Delete file                                                               |
| `src/mcp/tools/code.ts`                                      | Remove try/catch, middleware handles errors                               |
| `src/mcp/tools/explore.ts`                                   | Same                                                                      |
| `src/mcp/tools/collection.ts`                                | Same                                                                      |
| `src/mcp/tools/document.ts`                                  | Same                                                                      |
| `src/core/adapters/embeddings/ollama.ts`                     | Catch raw errors → `OllamaUnavailableError` / `OllamaModelMissingError`   |
| `src/core/adapters/embeddings/onnx.ts`                       | Catch raw errors → `OnnxModelLoadError` / `OnnxInferenceError`            |
| `src/core/adapters/embeddings/onnx/daemon.ts`                | Catch raw errors → typed errors                                           |
| `src/core/adapters/embeddings/onnx/worker.ts`                | Catch raw errors → typed errors                                           |
| `src/core/adapters/embeddings/openai.ts`                     | Catch raw errors → `OpenAIRateLimitError` / `OpenAIAuthError`             |
| `src/core/adapters/embeddings/cohere.ts`                     | Catch raw errors → `CohereRateLimitError`                                 |
| `src/core/adapters/embeddings/voyage.ts`                     | Catch raw errors → `VoyageRateLimitError`                                 |
| `src/core/adapters/embeddings/factory.ts`                    | Throw `ConfigValueMissingError` / `ConfigValueInvalidError`               |
| `src/core/adapters/qdrant/client.ts`                         | Catch raw errors → `QdrantUnavailableError` / `QdrantOperationError`      |
| `src/core/adapters/qdrant/embedded/daemon.ts`                | Catch raw errors → typed errors                                           |
| `src/core/adapters/qdrant/embedded/download.ts`              | Catch raw errors → typed errors                                           |
| `src/core/adapters/qdrant/scroll.ts`                         | Catch raw errors → typed errors                                           |
| `src/core/adapters/qdrant/sparse.ts`                         | Catch raw errors → typed errors                                           |
| `src/core/adapters/qdrant/accumulator.ts`                    | Catch raw errors → typed errors                                           |
| `src/core/adapters/qdrant/schema-migration.ts`               | Catch raw errors → typed errors                                           |
| `src/core/adapters/git/client.ts`                            | Catch raw errors → `GitCliNotFoundError` / `GitCliTimeoutError`           |
| `src/core/domains/ingest/indexing.ts`                        | Use `CollectionExistsError`                                               |
| `src/core/domains/ingest/reindexing.ts`                      | Use `NotIndexedError`, `SnapshotMissingError`                             |
| `src/core/domains/ingest/pipeline/base.ts`                   | Typed errors for pipeline failures                                        |
| `src/core/domains/ingest/pipeline/chunk-pipeline.ts`         | Typed errors                                                              |
| `src/core/domains/ingest/pipeline/file-processor.ts`         | Typed errors                                                              |
| `src/core/domains/ingest/pipeline/pipeline-manager.ts`       | Typed errors                                                              |
| `src/core/domains/ingest/pipeline/status-module.ts`          | Typed errors                                                              |
| `src/core/domains/ingest/pipeline/chunker/infra/pool.ts`     | Typed errors                                                              |
| `src/core/domains/ingest/pipeline/enrichment/coordinator.ts` | Typed errors                                                              |
| `src/core/domains/ingest/sync/parallel-synchronizer.ts`      | Typed errors                                                              |
| `src/core/domains/ingest/sync/synchronizer.ts`               | Typed errors                                                              |
| `src/core/domains/ingest/sync/deletion-strategy.ts`          | Typed errors                                                              |
| `src/core/domains/ingest/sync/sharded-snapshot.ts`           | Typed errors                                                              |
| `src/core/domains/ingest/sync/migration.ts`                  | Typed errors                                                              |
| `src/core/domains/explore/strategies/types.ts`               | Remove old `HybridNotEnabledError`, use new one                           |
| `src/core/api/internal/facades/explore-facade.ts`            | Remove old errors, add `CollectionNotProvidedError` validation            |
| `src/core/infra/collection-name.ts`                          | Remove `CollectionRefError`, remove validation from `resolveCollection()` |
| `website/docs/operations/troubleshooting.md`                 | Rename + add error codes reference by domain                              |
| `plugin/rules/search-cascade.md`                             | Update error handling: agent proposes fix, executes after confirmation    |
| `.claude/rules/typed-errors.md`                              | New rule: mandatory typed errors                                          |

---

## 9. Typed Errors Rule

**File:** `.claude/rules/typed-errors.md`

A project rule enforcing that all new code uses typed errors from the hierarchy.

Key points:

- NEVER `throw new Error("message")` — always use a concrete error class
- Each adapter catches raw errors and throws typed errors with external API
  messages in `cause`
- Each domain throws domain-specific errors
- Facades validate input and throw `InputValidationError` subclasses
- Programming errors (invariant violations) are the only exception — plain
  `Error` is acceptable
- MCP tool handlers NEVER contain try/catch — middleware handles all errors
