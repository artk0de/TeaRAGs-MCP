# Centralized Config Module

**Date:** 2026-03-05 **Status:** Approved

## Problem

119 `process.env` reads scattered across 28 files. Fallback chains duplicated,
`parseInt` ad-hoc, `AppConfig` incomplete, debug logger ENV dump drifts
manually.

## Decision

Full centralization: one Zod schema parses all ~40 env vars, validated at
startup. Domain modules receive typed config slices via DI (hybrid: constructor
at module entry points, module-level variable internally).

## Design

### Config Structure

```ts
interface AppConfig {
  core: CoreConfig; // debug, qdrantUrl, qdrantApiKey, transport, httpPort, timeout, promptsFile
  embedding: EmbeddingConfig; // provider, model, dimensions, baseUrl, apiKeys, tune params
  ingest: IngestConfig; // chunkSize, overlap, enableAST, enableHybrid, searchLimit, tune params
  trajectoryGit: TrajectoryGitConfig; // enabled, logMaxAge, timeouts, chunk concurrency, squash
  qdrantTune: QdrantTuneConfig; // upsert batch/flush/ordering, delete batch/concurrency/flush
}
```

### Zod Schema with Fallback Chains

Each field uses `z.preprocess()` with `envWithFallback()` helper:

```ts
function envWithFallback(
  newName: string,
  ...oldNames: string[]
): string | undefined {
  if (process.env[newName]) return process.env[newName];
  for (const old of oldNames) {
    if (process.env[old]) {
      deprecations.push({ oldName: old, newName });
      return process.env[old];
    }
  }
  return undefined;
}
```

Single `appConfigSchema.safeParse({})` — input is empty, all values come from
`process.env` via preprocess.

### Validation & Error Reporting

On parse failure, `ZodError` is formatted into readable stderr output:

```
Configuration errors:
  SERVER_HTTP_PORT: Expected number, got "abc"
  EMBEDDING_PROVIDER: Must be one of: ollama, openai, cohere, voyage
```

MCP clients (Claude Code, Cursor) show stderr when server process dies. All
errors reported at once, not fail-on-first.

### Deprecation Warnings

If old env var name is used, warning printed to stderr once at startup:

```
Deprecated env vars (still working, please migrate):
  TRANSPORT_MODE -> SERVER_TRANSPORT
  CODE_BATCH_SIZE -> QDRANT_TUNE_UPSERT_BATCH_SIZE
```

### DI: Config Slice Distribution

`api/` (composition root) receives full `AppConfig`, slices it for domain
modules:

```
index.ts -> parseAppConfig() -> AppConfig
  -> createAppContext(config)
       EmbeddingProviderFactory.create(config.embedding)
       new QdrantManager(config.core, config.qdrantTune)
       IngestFacade(..., config.ingest)
       GitEnrichmentProvider(..., config.trajectoryGit)
```

Domain modules accept typed slice via constructor. Internal classes receive
slice from module entry point (module-level variable), not through every
constructor.

### Debug Logger

Replaces manual ENV dump with `getConfigDump()`:

```ts
function getConfigDump(): Record<string, string | number | boolean>;
// Returns flat map: { "core.debug": true, "embedding.model": "jina-...", ... }
```

Logger calls it, no knowledge of specific fields, no drift.

### Testing Strategy

1. **`tests/bootstrap/config.test.ts`** — Zod defaults, fallback chains,
   deprecation collection, validation errors, getConfigDump
2. **Existing env test files** — migrate to call `parseAppConfig()`, no dynamic
   imports needed
3. **Domain module tests** — pass typed config fixture, no `process.env`
   manipulation

## Affected Files

**Rewrite:** `src/bootstrap/config.ts`

**DI signature changes (~16 files):**

- `src/bootstrap/factory.ts`
- `src/core/adapters/embeddings/factory.ts`, `ollama.ts`
- `src/core/adapters/qdrant/accumulator.ts`, `client.ts`
- `src/core/adapters/git/client.ts`
- `src/core/ingest/pipeline/types.ts`, `base.ts`, `file-processor.ts`
- `src/core/ingest/pipeline/infra/parallel.ts`, `debug-logger.ts`
- `src/core/ingest/sync/parallel-synchronizer.ts`
- `src/core/ingest/reindexing.ts`
- `src/core/trajectory/git/provider.ts`, `infra/file-reader.ts`,
  `infra/chunk-reader.ts`

**Tests:** `tests/bootstrap/config.test.ts` (new) + refactor ~15 existing test
files

**No changes:** MCP tools, schemas, reranker, presets, signals, filters,
documentation
