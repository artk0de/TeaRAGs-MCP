# Unified Error Handling — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development
> (if subagents available) or superpowers:executing-plans to implement this
> plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Standardized error hierarchy with human-readable messages, graceful
startup, MCP error middleware, documented error codes, and a project rule
enforcing typed errors.

**Architecture:** Abstract base classes per domain, concrete leaf classes with
typed constructors. MCP middleware catches all errors. Adapters catch raw errors
and throw typed ones. Server never crashes from unavailable dependencies.

**Tech Stack:** TypeScript, Vitest, MCP SDK

**Spec:** `docs/superpowers/specs/2026-03-18-error-handling-design.md`

---

### Task 1: Error Contract & Base Classes

**Files:**

- Create: `src/core/contracts/errors.ts`
- Create: `src/core/infra/errors.ts`
- Create: `src/core/api/errors.ts`
- Modify: `src/core/api/internal/facades/explore-facade.ts`
- Modify: `src/core/infra/collection-name.ts`
- Test: `tests/core/infra/errors.test.ts`
- Test: `tests/core/api/errors.test.ts`

- [ ] **Step 1: Write failing tests for TeaRagsError base class**

Test `toUserMessage()` format, `toString()` format, `code`, `message`, `hint`,
`httpStatus`, `cause` chain, `instanceof Error`.

- [ ] **Step 2: Run tests — expect FAIL (module not found)**

Run: `npx vitest run tests/core/infra/errors.test.ts`

- [ ] **Step 3: Create `src/core/contracts/errors.ts`**

Define `TeaRagsErrorContract` interface (5 fields) and `ErrorCode` string
literal union covering all domains.

- [ ] **Step 4: Create `src/core/infra/errors.ts`**

Implement `abstract TeaRagsError extends Error implements TeaRagsErrorContract`
with `toUserMessage()` and `toString()`. Also implement `UnknownError` (code
`UNKNOWN_ERROR`, httpStatus 500, wraps any unknown error).

- [ ] **Step 5: Run tests — expect PASS**

Run: `npx vitest run tests/core/infra/errors.test.ts`

- [ ] **Step 6: Write failing tests for InputValidationError and
      CollectionNotProvidedError**

Test `instanceof` chain
(`CollectionNotProvidedError instanceof InputValidationError instanceof TeaRagsError`),
`code` `INPUT_COLLECTION_NOT_PROVIDED`, `httpStatus` 400, `toUserMessage()`.

- [ ] **Step 7: Run tests — expect FAIL**

Run: `npx vitest run tests/core/api/errors.test.ts`

- [ ] **Step 8: Create `src/core/api/errors.ts`**

Implement `abstract InputValidationError extends TeaRagsError` (default
httpStatus 400) and `CollectionNotProvidedError extends InputValidationError`.

- [ ] **Step 9: Run tests — expect PASS**

Run: `npx vitest run tests/core/api/errors.test.ts`

- [ ] **Step 10: Migrate CollectionRefError**

In `src/core/infra/collection-name.ts`: delete `CollectionRefError` class,
remove the `if (!collection && !path) throw new CollectionRefError()` from
`resolveCollection()`.

In `src/core/api/internal/facades/explore-facade.ts`: add validation
`if (!collection && !path) throw new CollectionNotProvidedError()` before
calling `resolveCollection()`. Check all other facades that call
`resolveCollection()` and add the same validation.

Update imports and existing tests that catch `CollectionRefError`.

- [ ] **Step 11: Update barrel files**

Add new error exports to relevant `index.ts` barrels (e.g.
`src/core/api/index.ts`).

- [ ] **Step 12: Run full test suite**

Run: `npx vitest run`

- [ ] **Step 13: Commit**

```bash
git commit -m "feat(contracts): add TeaRagsError hierarchy, InputValidationError, migrate CollectionRefError"
```

---

### Task 2: InfraError & Adapter Errors (parallelizable with Tasks 3, 4)

**Files:**

- Create: `src/core/adapters/errors.ts`
- Create: `src/core/adapters/qdrant/errors.ts`
- Create: `src/core/adapters/embeddings/errors.ts`
- Create: `src/core/adapters/embeddings/ollama/errors.ts`
- Create: `src/core/adapters/embeddings/onnx/errors.ts`
- Create: `src/core/adapters/embeddings/openai/errors.ts`
- Create: `src/core/adapters/embeddings/cohere/errors.ts`
- Create: `src/core/adapters/embeddings/voyage/errors.ts`
- Create: `src/core/adapters/git/errors.ts`
- Test: `tests/core/adapters/errors.test.ts`

- [ ] **Step 1: Write failing tests for all adapter error classes**

Test `instanceof` chain for each class (e.g.
`OllamaUnavailableError instanceof EmbeddingError instanceof InfraError instanceof TeaRagsError`),
typed constructor parameters (url, model, cause), `code`, `httpStatus`,
`toUserMessage()` includes parameter values.

- [ ] **Step 2: Run tests — expect FAIL**

Run: `npx vitest run tests/core/adapters/errors.test.ts`

- [ ] **Step 3: Create `src/core/adapters/errors.ts`**

Implement `abstract InfraError extends TeaRagsError` (default httpStatus 503).

- [ ] **Step 4: Create adapter error files**

Each file implements concrete error classes extending `InfraError` or
`EmbeddingError`:

- `qdrant/errors.ts`: `QdrantUnavailableError(url, cause?)`,
  `QdrantTimeoutError(url, operation, cause?)`,
  `QdrantOperationError(operation, detail, cause?)` (httpStatus 500)
- `embeddings/errors.ts`: `abstract EmbeddingError extends InfraError`
- `embeddings/ollama/errors.ts`: `OllamaUnavailableError(url, cause?)`,
  `OllamaModelMissingError(model, url)`
- `embeddings/onnx/errors.ts`: `OnnxModelLoadError(modelPath, cause?)`,
  `OnnxInferenceError(detail, cause?)`
- `embeddings/openai/errors.ts`: `OpenAIRateLimitError(cause?)`,
  `OpenAIAuthError(cause?)`
- `embeddings/cohere/errors.ts`: `CohereRateLimitError(cause?)`
- `embeddings/voyage/errors.ts`: `VoyageRateLimitError(cause?)`
- `git/errors.ts`: `GitCliNotFoundError()`,
  `GitCliTimeoutError(command, timeoutMs, cause?)`

- [ ] **Step 5: Run tests — expect PASS**

Run: `npx vitest run tests/core/adapters/errors.test.ts`

- [ ] **Step 6: Update barrel files**

Re-export errors from adapter barrel files where applicable.

- [ ] **Step 7: Commit**

```bash
git commit -m "feat(adapters): add InfraError hierarchy with adapter-specific errors"
```

---

### Task 3: Domain Errors (Ingest, Explore, Trajectory) (parallelizable with Tasks 2, 4)

**Files:**

- Create: `src/core/domains/ingest/errors.ts`
- Create: `src/core/domains/explore/errors.ts`
- Create: `src/core/domains/trajectory/errors.ts`
- Create: `src/core/domains/trajectory/git/errors.ts`
- Create: `src/core/domains/trajectory/static/errors.ts`
- Test: `tests/core/domains/ingest/errors.test.ts`
- Test: `tests/core/domains/explore/errors.test.ts`
- Test: `tests/core/domains/trajectory/errors.test.ts`

- [ ] **Step 1: Write failing tests for all domain error classes**

Test `instanceof` chains, codes, httpStatus, `toUserMessage()` for each:

Ingest: `NotIndexedError(path)` → 404, `CollectionExistsError(collectionName)` →
409, `SnapshotMissingError(path)` → 404.

Explore: `CollectionNotFoundError(collectionName)` → 404,
`HybridNotEnabledError(collectionName)` → 400, `InvalidQueryError(reason)`
→ 400.

Trajectory: `GitBlameFailedError(file, cause?)`,
`GitLogTimeoutError(timeoutMs, cause?)`, `GitNotAvailableError(cause?)`,
`StaticParseFailedError(file, cause?)`.

Test multi-level instanceof:
`GitBlameFailedError instanceof TrajectoryGitError instanceof TrajectoryError instanceof TeaRagsError`.

- [ ] **Step 2: Run tests — expect FAIL**

- [ ] **Step 3: Implement all domain error files**

Each base class is `abstract`, concrete classes have typed constructors.

- [ ] **Step 4: Run tests — expect PASS**

- [ ] **Step 5: Update barrel files**

Re-export errors from domain barrel files (`src/core/domains/ingest/index.ts`,
`src/core/domains/explore/index.ts`, `src/core/domains/trajectory/index.ts`,
`src/core/domains/trajectory/git/index.ts`,
`src/core/domains/trajectory/static/index.ts`).

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(domains): add IngestError, ExploreError, TrajectoryError hierarchies"
```

---

### Task 4: ConfigError & Bootstrap Errors (parallelizable with Tasks 2, 3)

**Files:**

- Create: `src/bootstrap/errors.ts`
- Modify: `src/core/adapters/embeddings/factory.ts`
- Test: `tests/bootstrap/errors.test.ts`

- [ ] **Step 1: Write failing tests**

Test `ConfigValueInvalidError(field, value, expected)` and
`ConfigValueMissingError(field, envVar)`: codes, httpStatus 400,
`toUserMessage()` includes field name and env var name.

- [ ] **Step 2: Run tests — expect FAIL**

- [ ] **Step 3: Create `src/bootstrap/errors.ts`**

`abstract ConfigError extends TeaRagsError` (default httpStatus 400),
`ConfigValueInvalidError`, `ConfigValueMissingError`.

- [ ] **Step 4: Run tests — expect PASS**

- [ ] **Step 5: Migrate `factory.ts`**

Replace `throw new Error("Missing API key for ...")` with
`throw new ConfigValueMissingError("apiKey", "OPENAI_API_KEY")` etc. Replace
`throw new Error("Unknown embedding provider ...")` with
`throw new ConfigValueInvalidError("embeddingProvider", value, "ollama | onnx | openai | cohere | voyage")`.

- [ ] **Step 6: Run full test suite**

Run: `npx vitest run`

- [ ] **Step 7: Commit**

```bash
git commit -m "feat(bootstrap): add ConfigError hierarchy, migrate factory.ts"
```

---

### Task 5: MCP Error Middleware

**Files:**

- Create: `src/mcp/middleware/error-handler.ts`
- Modify: `src/mcp/tools/code.ts`
- Modify: `src/mcp/tools/explore.ts`
- Modify: `src/mcp/tools/collection.ts`
- Modify: `src/mcp/tools/document.ts`
- Test: `tests/mcp/middleware/error-handler.test.ts`

- [ ] **Step 1: Write failing tests for errorHandlerMiddleware**

Test 3 cases:

1. Handler succeeds → returns result unchanged
2. Handler throws `TeaRagsError` → returns
   `{ content: [{ type: "text", text: e.toUserMessage() }], isError: true }`
3. Handler throws unknown `Error` → wraps in `UnknownError`, returns same format

- [ ] **Step 2: Run tests — expect FAIL**

- [ ] **Step 3: Create `src/mcp/middleware/error-handler.ts`**

Implement `errorHandlerMiddleware<T>(handler)` with correct
`(args: T, extra: RequestHandlerExtra)` signature. Log to stderr before
formatting. Also export `registerToolSafe(server, name, metadata, handler)`
helper.

- [ ] **Step 4: Run tests — expect PASS**

- [ ] **Step 5: Migrate tool files**

In each tool file (`code.ts`, `explore.ts`, `collection.ts`, `document.ts`):

1. Replace `server.registerTool` with `registerToolSafe`
2. Remove all try/catch blocks from handlers
3. Import `registerToolSafe` from `../middleware/error-handler.js`

- [ ] **Step 6: Run full test suite**

Run: `npx vitest run`

- [ ] **Step 7: Commit**

```bash
git commit -m "feat(mcp): add errorHandlerMiddleware, migrate all tools to registerToolSafe"
```

---

### Task 6: Graceful Startup

**Files:**

- Modify: `src/index.ts`
- Delete: `src/bootstrap/ollama.ts`
- Delete: `tests/bootstrap/ollama.test.ts`

- [ ] **Step 1: Write test — server starts without Ollama/Qdrant**

Test that `main()` or `createAppContext()` does not throw when dependencies are
unavailable. Mock fetch to reject.

- [ ] **Step 2: Run test — expect FAIL (current code crashes)**

- [ ] **Step 3: Remove `checkOllamaAvailability()` call from `src/index.ts`**

Delete the import and the function call.

- [ ] **Step 4: Delete `src/bootstrap/ollama.ts`**

- [ ] **Step 5: Delete `tests/bootstrap/ollama.test.ts`**

- [ ] **Step 6: Run test — expect PASS**

- [ ] **Step 7: Run full test suite**

Run: `npx vitest run`

- [ ] **Step 8: Commit**

```bash
git commit -m "improve(bootstrap): graceful startup — remove pre-flight Ollama check"
```

---

### Task 7: Migrate Adapter throw sites

Read each adapter file, find ALL `throw` / `catch` / error paths, replace with
typed errors. Include messages from external APIs in `message` field.

**Sub-task 7a: `adapters/embeddings/ollama.ts`**

- [ ] Write failing test: Ollama adapter throws `OllamaUnavailableError` on
      fetch failure
- [ ] Write failing test: Ollama adapter throws `OllamaModelMissingError` on
      model not found
- [ ] Read file, identify all throw sites
- [ ] Replace raw errors with `OllamaUnavailableError` /
      `OllamaModelMissingError`
- [ ] Preserve external API error messages in `cause` and `message`
- [ ] Update existing tests
- [ ] Run tests, commit

**Sub-task 7b: `adapters/embeddings/onnx.ts` + `onnx/daemon.ts` +
`onnx/worker.ts`**

- [ ] Write failing tests for `OnnxModelLoadError` / `OnnxInferenceError` throws
- [ ] Read files, identify all throw sites
- [ ] Replace with `OnnxModelLoadError` / `OnnxInferenceError`
- [ ] Add new error classes to `onnx/errors.ts` if needed
- [ ] Update existing tests
- [ ] Run tests, commit

**Sub-task 7c: `adapters/embeddings/openai.ts`**

- [ ] Write failing tests for `OpenAIRateLimitError` / `OpenAIAuthError` throws
- [ ] Read file, identify all throw sites
- [ ] Replace with `OpenAIRateLimitError` / `OpenAIAuthError`
- [ ] Add new error classes if needed
- [ ] Update existing tests
- [ ] Run tests, commit

**Sub-task 7d: `adapters/embeddings/cohere.ts`**

- [ ] Write failing test for `CohereRateLimitError` throw
- [ ] Read file, identify all throw sites
- [ ] Replace with `CohereRateLimitError`
- [ ] Add new error classes if needed
- [ ] Update existing tests
- [ ] Run tests, commit

**Sub-task 7e: `adapters/embeddings/voyage.ts`**

- [ ] Write failing test for `VoyageRateLimitError` throw
- [ ] Read file, identify all throw sites
- [ ] Replace with `VoyageRateLimitError`
- [ ] Add new error classes if needed
- [ ] Update existing tests
- [ ] Run tests, commit

**Sub-task 7f: `adapters/qdrant/client.ts`**

- [ ] Write failing test: Qdrant adapter throws `QdrantUnavailableError` on
      connection failure
- [ ] Write failing test: Qdrant adapter throws `QdrantOperationError` on
      operation failure
- [ ] Read file, identify all throw sites
- [ ] Replace with `QdrantUnavailableError` / `QdrantOperationError` /
      `QdrantTimeoutError`
- [ ] Add new error classes to `qdrant/errors.ts` if needed
- [ ] Update existing tests
- [ ] Run tests, commit

**Sub-task 7g: `adapters/qdrant/embedded/daemon.ts` + `embedded/download.ts`**

- [ ] Write failing tests for typed errors from daemon/download
- [ ] Read files, identify all throw sites
- [ ] Replace with typed errors (add to `qdrant/errors.ts` if needed)
- [ ] Update existing tests
- [ ] Run tests, commit

**Sub-task 7h: `adapters/qdrant/scroll.ts` + `sparse.ts` + `accumulator.ts`**

- [ ] Write failing tests for typed errors from scroll/sparse/accumulator
- [ ] Read files, identify all throw sites
- [ ] Replace with typed errors
- [ ] Update existing tests
- [ ] Run tests, commit

**Sub-task 7i: `adapters/qdrant/schema-migration.ts`**

- [ ] Write failing tests for typed errors from schema-migration
- [ ] Read file, identify all throw sites
- [ ] Replace with typed errors
- [ ] Update existing tests
- [ ] Run tests, commit

**Sub-task 7j: `adapters/git/client.ts`**

- [ ] Write failing test: git adapter throws `GitCliNotFoundError` when git not
      installed
- [ ] Write failing test: git adapter throws `GitCliTimeoutError` on timeout
- [ ] Read file, identify all throw sites
- [ ] Replace with `GitCliNotFoundError` / `GitCliTimeoutError`
- [ ] Add new error classes if needed
- [ ] Update existing tests
- [ ] Run tests, commit

---

### Task 8: Migrate Domain throw sites

Read each domain file, find ALL `throw` / `catch` / error paths, replace with
typed errors.

**Sub-task 8a: `ingest/indexing.ts` + `ingest/reindexing.ts`**

- [ ] Write failing tests: reindexing throws `NotIndexedError` /
      `SnapshotMissingError`, indexing throws `CollectionExistsError`
- [ ] Read files, identify all throw sites
- [ ] Replace with `NotIndexedError`, `CollectionExistsError`,
      `SnapshotMissingError`
- [ ] Update existing tests
- [ ] Run tests, commit

**Sub-task 8b: `ingest/pipeline/base.ts` + `chunk-pipeline.ts` +
`file-processor.ts`**

- [ ] Write failing tests for typed error throws from pipeline components
- [ ] Read files, identify all throw sites
- [ ] Replace with typed errors (add to `ingest/errors.ts` if needed)
- [ ] Update existing tests
- [ ] Run tests, commit

**Sub-task 8c: `ingest/pipeline/pipeline-manager.ts` + `status-module.ts`**

- [ ] Read files, identify all throw sites
- [ ] Programming errors ("Pipeline not started") — leave as plain Error
      (intentionally excluded)
- [ ] Write failing tests for user-facing errors
- [ ] User-facing errors — replace with typed
- [ ] Update existing tests
- [ ] Run tests, commit

**Sub-task 8d: `ingest/pipeline/chunker/` — pool.ts, worker.ts, tree-sitter.ts,
base.ts**

- [ ] Write failing test: "ChunkerPool is shut down" throws typed `IngestError`
      subclass
- [ ] Read files, identify all throw sites
- [ ] Replace with typed errors where user-facing
- [ ] Update existing tests
- [ ] Run tests, commit

**Sub-task 8e: `ingest/pipeline/enrichment/` — coordinator.ts, applier.ts**

- [ ] Write failing tests for typed error throws from enrichment
- [ ] Read files, identify all throw sites
- [ ] Replace with typed errors
- [ ] Update existing tests
- [ ] Run tests, commit

**Sub-task 8f: `ingest/pipeline/infra/` — worker-pool.ts, batch-accumulator.ts**

- [ ] Write failing tests for typed error throws from infra components
- [ ] Read files, identify all throw sites
- [ ] Replace with typed errors
- [ ] Update existing tests
- [ ] Run tests, commit

**Sub-task 8g: `ingest/sync/` — parallel-synchronizer.ts, synchronizer.ts,
deletion-strategy.ts, sharded-snapshot.ts, migration.ts**

- [ ] Write failing tests for typed errors from sync layer (e.g.
      `SnapshotCorruptedError`, `MigrationFailedError`)
- [ ] Read files, identify all throw sites
- [ ] Replace with typed errors
- [ ] Update existing tests
- [ ] Run tests, commit

**Sub-task 8h: `explore/` — strategies, facade**

- [ ] Write failing tests for new typed errors in explore
- [ ] Read all explore files, identify all throw sites
- [ ] Replace old `HybridNotEnabledError`, `CollectionNotFoundError` with new
      ones
- [ ] Replace facade throw sites from migration table:
  - `"Strategy requires at least one positive input"` → `InvalidQueryError`
  - `"At least one positive or negative input"` → `InvalidQueryError`
  - `"Collection not found. Index first."` → `CollectionNotFoundError`
  - `"No statistics available."` → `NotIndexedError`
- [ ] Update existing tests
- [ ] Run tests, commit

**Sub-task 8i: `trajectory/git/` — all throw sites**

- [ ] Write failing tests for typed git trajectory errors
- [ ] Read all git trajectory files, identify all throw sites
- [ ] Replace with `GitBlameFailedError`, `GitLogTimeoutError`,
      `GitNotAvailableError`
- [ ] Add new error classes if needed
- [ ] Update existing tests
- [ ] Run tests, commit

**Sub-task 8j: `trajectory/static/` — all throw sites**

- [ ] Write failing test for `StaticParseFailedError` throw
- [ ] Read all static trajectory files, identify all throw sites
- [ ] Replace with `StaticParseFailedError`
- [ ] Add new error classes if needed
- [ ] Update existing tests
- [ ] Run tests, commit

**Sub-task 8k: `api/internal/facades/ingest-facade.ts` + other facades —
validation**

- [ ] Write failing test: `ingest-facade.ts` throws `CollectionNotProvidedError`
      when neither collection nor path provided
- [ ] Read `ingest-facade.ts` and all other facades (except `explore-facade.ts`
      — done in Task 1)
- [ ] Add `CollectionNotProvidedError` validation before `resolveCollection()`
      calls
- [ ] Update existing tests
- [ ] Run tests, commit

---

### Task 9: Documentation — Troubleshooting & Error Codes

**Files:**

- Rename: `website/docs/operations/troubleshooting.md` →
  `troubleshooting-and-error-codes.md`
- Modify: sidebar config if applicable

- [ ] **Step 1: Rename file**

- [ ] **Step 2: Break existing tables by error domain**

Sections: Infrastructure, Indexing, Explore, Trajectory, Configuration.

- [ ] **Step 3: Add error code column to each table**

- [ ] **Step 4: Add "Error Codes Reference" section**

Full table of all codes, message template, hint template, httpStatus.

- [ ] **Step 5: Add MCP response format examples**

- [ ] **Step 6: Commit**

```bash
git commit -m "docs(operations): add error codes reference, rename troubleshooting page"
```

---

### Task 10: search-cascade Update

**Files:**

- Modify: `plugin/rules/search-cascade.md` (or wherever the rule lives)

- [ ] **Step 1: Find search-cascade rule file**

- [ ] **Step 2: Update session-start section**

When `get_index_status` returns an error:

1. Agent reads `code` and `hint`
2. Proposes concrete fix action to user with confirmation
3. Executes fix after confirmation (e.g. `docker compose up -d`,
   `ollama pull ...`)
4. Retries `get_index_status`
5. Reconnect MCP only if config change needed

- [ ] **Step 3: Commit**

```bash
git commit -m "docs(dx): update search-cascade for typed error handling"
```

---

### Task 11: Typed Errors Rule

**Files:**

- Create: `.claude/rules/typed-errors.md`

- [ ] **Step 1: Write rule**

Contents:

- NEVER `throw new Error("message")` — always use a concrete error class from
  the hierarchy
- Each adapter catches raw errors and throws typed errors with external API
  messages in `cause`
- Each domain throws domain-specific errors
- Facades validate input and throw `InputValidationError` subclasses before
  calling infra
- Programming errors (invariant violations) are the only acceptable plain
  `Error`
- MCP tool handlers NEVER contain try/catch — `registerToolSafe` and middleware
  handle all errors
- Reference: `docs/superpowers/specs/2026-03-18-error-handling-design.md`

- [ ] **Step 2: Commit**

```bash
git commit -m "docs(dx): add typed-errors rule for mandatory error hierarchy usage"
```
