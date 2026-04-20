---
title: "Failure Model"
sidebar_position: 1
---

# Failure Model

How TeaRAGs handles things going wrong: what can fail, what's retried automatically, what falls back, and what surfaces to the caller as a typed error. This page complements [Troubleshooting & Error Codes](/operations/troubleshooting-and-error-codes) — that one lists codes and fixes; this one explains the philosophy.

## Error Hierarchy

Every runtime error is a concrete subclass of `TeaRagsError`. The MCP server never returns a generic `Error` to clients — every failure carries a stable code and an actionable hint. Source: `src/core/contracts/errors.ts` and the domain-specific error files.

```
TeaRagsError (abstract)                    src/core/infra/errors.ts
  ├─ UnknownError                          src/core/infra/errors.ts
  ├─ InputValidationError (abstract)       src/core/api/errors.ts
  ├─ InfraError (abstract)                 src/core/adapters/errors.ts
  ├─ IngestError (abstract)                src/core/domains/ingest/errors.ts
  ├─ ExploreError (abstract)               src/core/domains/explore/errors.ts
  ├─ TrajectoryError (abstract)            src/core/domains/trajectory/errors.ts
  └─ ConfigError (abstract)                src/bootstrap/errors.ts
```

Every response from a failing tool follows the same shape:

```text
Error [<CODE>]: <message>

Hint: <actionable fix>
```

Agents should parse `[CODE]` first, then read the hint — it's the line that tells them what to do next.

## What's Retried vs What's Surfaced

The tooling is conservative: **transient faults retry, permanent faults surface**. The line between them is drawn per error class, not per adapter.

| Failure mode | Behaviour | Why |
|--------------|-----------|-----|
| Qdrant transient timeout | Surfaced (`INFRA_QDRANT_TIMEOUT`) | The caller's retry is better — we don't know if they want to wait or abort |
| Qdrant unreachable | Surfaced (`INFRA_QDRANT_UNAVAILABLE`) | Likely misconfiguration; silent retry would mask it |
| Embedding rate limit (OpenAI / Cohere / Voyage) | **Retried** with exponential backoff + `Retry-After` | Provider guarantees the limit will lift; invisible to the caller |
| Embedding transient 5xx | **Retried** (bounded by `EMBEDDING_TUNE_RETRY_ATTEMPTS`) | Same reason |
| Ollama model missing | **Retried once after model pull**; then surfaced (`INFRA_EMBEDDING_OLLAMA_MODEL_MISSING`) | One self-heal attempt, then user must intervene |
| Ollama unreachable | **Fallback to ONNX** if configured; otherwise surfaced | Local-first UX — don't break when the daemon dies |
| Git CLI timeout during enrichment | Logged, **does not fail indexing** | Enrichment is best-effort; base payload is still usable |
| File parse error (tree-sitter) | Logged + **chunk falls back to text splitting**; does not fail indexing | One unparseable file shouldn't kill a monorepo index |

### Retry with backoff — where it lives

Each cloud embedding provider has its own `retryWithBackoff` method:

- `src/core/adapters/embeddings/openai.ts` → `OpenAIEmbeddings#retryWithBackoff`
- `src/core/adapters/embeddings/ollama.ts` → `OllamaEmbeddings#retryWithBackoff`
- `src/core/adapters/embeddings/cohere.ts` → `CohereEmbeddings#retryWithBackoff`
- `src/core/adapters/embeddings/voyage.ts` → `VoyageEmbeddings#retryWithBackoff`

Tunable via `EMBEDDING_TUNE_RETRY_ATTEMPTS` (default `3`) and `EMBEDDING_TUNE_RETRY_DELAY_MS` (default `1000`, exponential).

### Ollama fallback to ONNX

`OllamaUnavailableError.withFallback` and `OllamaEmbeddings#switchToFallback` let the indexer switch to ONNX mid-run if Ollama becomes unreachable. The fallback is **opt-in** via configuration — no silent provider swaps without user intent.

## MCP Tool Error Contract

**Tool handlers never contain `try/catch`.** All error handling is centralized in `errorHandlerMiddleware` via `registerToolSafe`. This guarantees:

- Every tool returns a consistent `{ isError: true, content: [{ type: "text", text: "Error [CODE]: ... Hint: ..." }] }` shape on failure
- Stack traces only leak in `DEBUG=1` mode
- No partial success: if a tool throws, nothing it claimed to do happened (Qdrant mutations are batched and rolled back on error)

## Indexing Consistency

Indexing has a **zero-downtime guarantee**: a failed run never corrupts the live index. Mechanisms:

1. **Versioned collection names** (`{name}_{embeddingModelId}_{schemaVersion}`). A fresh index creates a new collection; the alias only switches after success. If the run fails, the alias stays pointed at the previous collection.
2. **Checkpoints** via indexing markers (`src/core/domains/ingest/pipeline/indexing-marker-codec.ts`). `ReindexPipeline#checkForCheckpoint` resumes from the last committed batch — no restart from zero on interruption.
3. **Snapshot persistence.** Snapshots (`~/.tea-rags/snapshots/`) are written **after** successful alias switch, so a crashed run doesn't poison the next incremental reindex.
4. **Conflict detection.** A parallel session indexing the same codebase is detected via the indexing marker; the second call returns a conflict error rather than racing writes.

The one scenario that requires manual intervention: **snapshot corruption**. Error code `INGEST_SNAPSHOT_CORRUPTED` instructs to delete and reindex — there's no partial recovery for a snapshot, only a fresh full run.

## Enrichment Failures

Git enrichment runs asynchronously **after** indexing returns. Failures are deliberately non-fatal:

- **Per-file failure** — one bad file (e.g. blob read error on a submodule) logs and moves on. The chunk keeps its base payload; `git.*` fields remain unset.
- **Per-commit failure** — chunk churn phase skips the commit and continues.
- **Pipeline-wide failure** — `TRAJECTORY_GIT_*` errors surface in `get_index_status` under enrichment state, but the index remains queryable.

Consequence: search works even on partially-enriched indexes. A file without `git.*` signals is filtered from ownership / techDebt / hotspots rerank but still ranks on similarity. Agents should check `get_index_status` to see enrichment progress before relying on trajectory signals.

## Reading an Error

Every error you'll see has three parts:

```text
Error [INFRA_EMBEDDING_OLLAMA_MODEL_MISSING]: Model "nomic-embed-text" is not available on Ollama at http://localhost:11434

Hint: Pull the model: ollama pull nomic-embed-text
```

1. **`[CODE]`** — stable identifier. Map it to the row in [Error Codes Reference](/operations/troubleshooting-and-error-codes#error-codes-reference).
2. **Message** — interpolated context (which URL, which file, what operation).
3. **Hint** — the concrete next step. Agents should prefer following the hint verbatim over improvising.

If a hint says "re-index with `forceReindex=true`", ask the user before running — it's a zero-downtime but long operation. See [Recovery & Reindexing](/operations/recovery-reindexing) for the full procedure.

## Related

- [Troubleshooting & Error Codes](/operations/troubleshooting-and-error-codes) — every code with a fix
- [Performance Diagnostics](/operations/performance-diagnostics) — health signals beyond error codes
- [Recovery & Reindexing](/operations/recovery-reindexing) — procedures for recovering from bad state
