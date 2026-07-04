# Centralized Config Module — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to
> implement this plan task-by-task.

**Goal:** Replace 119 scattered `process.env` reads across 28 files with a
single Zod-parsed, typed config object distributed via DI slices.

**Architecture:** One Zod schema in `bootstrap/config.ts` parses all ~40 env
vars at startup. `api/` (composition root) slices the config and passes typed
slices to domain modules via constructor/factory DI. `process.env.DEBUG` guards
(~20 occurrences) receive `debug` boolean from config slice.

**Tech Stack:** Zod (already in project), TypeScript strict mode

---

### Task 1: Zod Config Schema — Core + Embedding

**Files:**

- Rewrite: `src/bootstrap/config.ts`
- Test: `tests/bootstrap/config.test.ts`

**Step 1: Write failing tests for core config parsing**

```ts
// tests/bootstrap/config.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// All env vars to clean between tests
const ALL_KEYS = [
  "DEBUG",
  "QDRANT_URL",
  "QDRANT_API_KEY",
  "SERVER_TRANSPORT",
  "TRANSPORT_MODE",
  "SERVER_HTTP_PORT",
  "HTTP_PORT",
  "SERVER_HTTP_TIMEOUT_MS",
  "HTTP_REQUEST_TIMEOUT_MS",
  "SERVER_PROMPTS_FILE",
  "PROMPTS_CONFIG_FILE",
  "EMBEDDING_PROVIDER",
  "EMBEDDING_MODEL",
  "EMBEDDING_DIMENSIONS",
  "EMBEDDING_BASE_URL",
  "OLLAMA_LEGACY_API",
  "OLLAMA_NUM_GPU",
  "OPENAI_API_KEY",
  "COHERE_API_KEY",
  "VOYAGE_API_KEY",
  "EMBEDDING_TUNE_CONCURRENCY",
  "EMBEDDING_CONCURRENCY",
  "EMBEDDING_TUNE_BATCH_SIZE",
  "EMBEDDING_BATCH_SIZE",
  "CODE_BATCH_SIZE",
  "EMBEDDING_TUNE_MIN_BATCH_SIZE",
  "MIN_BATCH_SIZE",
  "EMBEDDING_TUNE_BATCH_TIMEOUT_MS",
  "BATCH_FORMATION_TIMEOUT_MS",
  "EMBEDDING_TUNE_MAX_REQUESTS_PER_MINUTE",
  "EMBEDDING_MAX_REQUESTS_PER_MINUTE",
  "EMBEDDING_TUNE_RETRY_ATTEMPTS",
  "EMBEDDING_RETRY_ATTEMPTS",
  "EMBEDDING_TUNE_RETRY_DELAY_MS",
  "EMBEDDING_RETRY_DELAY",
];

function cleanEnv() {
  for (const key of ALL_KEYS) delete process.env[key];
}

describe("parseAppConfig — core", () => {
  beforeEach(cleanEnv);
  afterEach(cleanEnv);

  it("returns defaults when no env vars set", async () => {
    const { parseAppConfig } = await import("../../src/bootstrap/config.js");
    const config = parseAppConfig();
    expect(config.core.debug).toBe(false);
    expect(config.core.qdrantUrl).toBe("http://localhost:6333");
    expect(config.core.transportMode).toBe("stdio");
    expect(config.core.httpPort).toBe(3000);
  });

  it("reads SERVER_TRANSPORT with TRANSPORT_MODE fallback", async () => {
    process.env.TRANSPORT_MODE = "http";
    const { parseAppConfig } = await import("../../src/bootstrap/config.js");
    const result = parseAppConfig();
    expect(result.core.transportMode).toBe("http");
  });

  it("collects deprecation warning for old env var name", async () => {
    process.env.TRANSPORT_MODE = "http";
    const { parseAppConfig } = await import("../../src/bootstrap/config.js");
    const result = parseAppConfig();
    expect(result.deprecations).toContainEqual({
      oldName: "TRANSPORT_MODE",
      newName: "SERVER_TRANSPORT",
    });
  });

  it("throws ZodError for invalid transport mode", async () => {
    process.env.SERVER_TRANSPORT = "grpc";
    const { parseAppConfig } = await import("../../src/bootstrap/config.js");
    expect(() => parseAppConfig()).toThrow(/SERVER_TRANSPORT/);
  });

  it("throws ZodError for invalid port", async () => {
    process.env.SERVER_TRANSPORT = "http";
    process.env.SERVER_HTTP_PORT = "abc";
    const { parseAppConfig } = await import("../../src/bootstrap/config.js");
    expect(() => parseAppConfig()).toThrow();
  });
});

describe("parseAppConfig — embedding", () => {
  beforeEach(cleanEnv);
  afterEach(cleanEnv);

  it("returns embedding defaults", async () => {
    const { parseAppConfig } = await import("../../src/bootstrap/config.js");
    const config = parseAppConfig();
    expect(config.embedding.provider).toBe("ollama");
    expect(config.embedding.tune.concurrency).toBe(1);
    expect(config.embedding.tune.batchSize).toBe(1024);
    expect(config.embedding.tune.retryAttempts).toBe(3);
  });

  it("reads EMBEDDING_TUNE_CONCURRENCY with EMBEDDING_CONCURRENCY fallback", async () => {
    process.env.EMBEDDING_CONCURRENCY = "4";
    const { parseAppConfig } = await import("../../src/bootstrap/config.js");
    const result = parseAppConfig();
    expect(result.embedding.tune.concurrency).toBe(4);
    expect(result.deprecations).toContainEqual({
      oldName: "EMBEDDING_CONCURRENCY",
      newName: "EMBEDDING_TUNE_CONCURRENCY",
    });
  });
});
```

**Step 2: Run tests — expect FAIL (parseAppConfig doesn't return new shape)**

```bash
npx vitest run tests/bootstrap/config.test.ts
```

Expected: FAIL — `config.core` is undefined (old shape has flat fields).

**Step 3: Implement Zod schema for core + embedding slices**

Rewrite `src/bootstrap/config.ts`:

```ts
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Deprecation tracking ──

export interface DeprecationNotice {
  oldName: string;
  newName: string;
}

let deprecations: DeprecationNotice[] = [];

/**
 * Read env var with fallback chain. Records deprecation if old name used.
 */
function envWithFallback(
  newName: string,
  ...oldNames: string[]
): string | undefined {
  const newVal = process.env[newName];
  if (newVal !== undefined && newVal !== "") return newVal;
  for (const old of oldNames) {
    const oldVal = process.env[old];
    if (oldVal !== undefined && oldVal !== "") {
      deprecations.push({ oldName: old, newName });
      return oldVal;
    }
  }
  return undefined;
}

// ── Zod helpers ──

const envString = (newName: string, ...oldNames: string[]) =>
  z.preprocess(
    () => envWithFallback(newName, ...oldNames),
    z.string().optional(),
  );

const envStringDefault = (
  defaultVal: string,
  newName: string,
  ...oldNames: string[]
) =>
  z.preprocess(
    () => envWithFallback(newName, ...oldNames) ?? defaultVal,
    z.string(),
  );

const envInt = (defaultVal: number, newName: string, ...oldNames: string[]) =>
  z.preprocess(() => {
    const raw = envWithFallback(newName, ...oldNames);
    return raw !== undefined ? parseInt(raw, 10) : defaultVal;
  }, z.number().int());

const envFloat = (defaultVal: number, newName: string, ...oldNames: string[]) =>
  z.preprocess(() => {
    const raw = envWithFallback(newName, ...oldNames);
    return raw !== undefined ? parseFloat(raw) : defaultVal;
  }, z.number());

const envBool = (defaultVal: boolean, newName: string, ...oldNames: string[]) =>
  z.preprocess(() => {
    const raw = envWithFallback(newName, ...oldNames);
    if (raw === undefined) return defaultVal;
    return raw === "true" || raw === "1";
  }, z.boolean());

// ── Schemas ──

const coreSchema = z.object({
  debug: envBool(false, "DEBUG"),
  qdrantUrl: envStringDefault("http://localhost:6333", "QDRANT_URL"),
  qdrantApiKey: envString("QDRANT_API_KEY"),
  transportMode: z.preprocess(
    () =>
      (
        envWithFallback("SERVER_TRANSPORT", "TRANSPORT_MODE") ?? "stdio"
      ).toLowerCase(),
    z.enum(["stdio", "http"]),
  ),
  httpPort: envInt(3000, "SERVER_HTTP_PORT", "HTTP_PORT"),
  requestTimeoutMs: envInt(
    300000,
    "SERVER_HTTP_TIMEOUT_MS",
    "HTTP_REQUEST_TIMEOUT_MS",
  ),
  promptsConfigFile: envStringDefault(
    join(__dirname, "../../prompts.json"),
    "SERVER_PROMPTS_FILE",
    "PROMPTS_CONFIG_FILE",
  ),
});

const embeddingTuneSchema = z.object({
  concurrency: envInt(1, "EMBEDDING_TUNE_CONCURRENCY", "EMBEDDING_CONCURRENCY"),
  batchSize: envInt(
    1024,
    "EMBEDDING_TUNE_BATCH_SIZE",
    "EMBEDDING_BATCH_SIZE",
    "CODE_BATCH_SIZE",
  ),
  minBatchSize: z.preprocess(() => {
    const raw = envWithFallback(
      "EMBEDDING_TUNE_MIN_BATCH_SIZE",
      "MIN_BATCH_SIZE",
    );
    return raw !== undefined ? parseInt(raw, 10) : undefined;
  }, z.number().int().optional()),
  batchTimeoutMs: envInt(
    2000,
    "EMBEDDING_TUNE_BATCH_TIMEOUT_MS",
    "BATCH_FORMATION_TIMEOUT_MS",
  ),
  maxRequestsPerMinute: z.preprocess(() => {
    const raw = envWithFallback(
      "EMBEDDING_TUNE_MAX_REQUESTS_PER_MINUTE",
      "EMBEDDING_MAX_REQUESTS_PER_MINUTE",
    );
    return raw !== undefined ? parseInt(raw, 10) : undefined;
  }, z.number().int().positive().optional()),
  retryAttempts: envInt(
    3,
    "EMBEDDING_TUNE_RETRY_ATTEMPTS",
    "EMBEDDING_RETRY_ATTEMPTS",
  ),
  retryDelayMs: envInt(
    1000,
    "EMBEDDING_TUNE_RETRY_DELAY_MS",
    "EMBEDDING_RETRY_DELAY",
  ),
});

const embeddingSchema = z.object({
  provider: z.preprocess(
    () => (envWithFallback("EMBEDDING_PROVIDER") ?? "ollama").toLowerCase(),
    z.enum(["ollama", "openai", "cohere", "voyage"]),
  ),
  model: envString("EMBEDDING_MODEL"),
  dimensions: z.preprocess(() => {
    const raw = envWithFallback("EMBEDDING_DIMENSIONS");
    return raw !== undefined ? parseInt(raw, 10) : undefined;
  }, z.number().int().positive().optional()),
  baseUrl: envString("EMBEDDING_BASE_URL"),
  ollamaLegacyApi: envBool(false, "OLLAMA_LEGACY_API"),
  ollamaNumGpu: envInt(999, "OLLAMA_NUM_GPU"),
  // API keys — read directly, no fallback chain
  openaiApiKey: envString("OPENAI_API_KEY"),
  cohereApiKey: envString("COHERE_API_KEY"),
  voyageApiKey: envString("VOYAGE_API_KEY"),
  tune: embeddingTuneSchema,
});

// ... (ingest, trajectoryGit, qdrantTune schemas in next tasks)

// Temporary: keep old fields for backwards compat during migration
const appConfigSchema = z.object({
  core: coreSchema,
  embedding: embeddingSchema,
  // Placeholders — filled in subsequent tasks:
  // ingest: ingestSchema,
  // trajectoryGit: trajectoryGitSchema,
  // qdrantTune: qdrantTuneSchema,
});

// ── Public API ──

export type CoreConfig = z.infer<typeof coreSchema>;
export type EmbeddingConfig = z.infer<typeof embeddingSchema>;
export type EmbeddingTuneConfig = z.infer<typeof embeddingTuneSchema>;
// Full config — grows as schemas are added
export type AppConfig = z.infer<typeof appConfigSchema> & {
  deprecations: DeprecationNotice[];
};

export function parseAppConfig(): AppConfig {
  deprecations = []; // reset for this parse
  const result = appConfigSchema.safeParse({});
  if (!result.success) {
    const lines = result.error.issues.map(
      (i) => `  ✗ ${i.path.join(".")}: ${i.message}`,
    );
    throw new Error(`Configuration errors:\n${lines.join("\n")}`);
  }
  return { ...result.data, deprecations };
}

export function printDeprecationWarnings(notices: DeprecationNotice[]): void {
  if (notices.length === 0) return;
  const lines = notices.map((n) => `  ${n.oldName} → ${n.newName}`);
  console.error(
    `⚠ Deprecated env vars (still working, please migrate):\n${lines.join("\n")}`,
  );
}

/** Flat dump of parsed config for debug logger */
export function getConfigDump(config: AppConfig): Record<string, unknown> {
  const dump: Record<string, unknown> = {};
  function flatten(obj: Record<string, unknown>, prefix: string) {
    for (const [key, value] of Object.entries(obj)) {
      if (key === "deprecations") continue;
      const path = prefix ? `${prefix}.${key}` : key;
      if (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value)
      ) {
        flatten(value as Record<string, unknown>, path);
      } else {
        dump[path] = value;
      }
    }
  }
  flatten(config as unknown as Record<string, unknown>, "");
  return dump;
}
```

NOTE: This is the initial implementation with core + embedding only. Ingest,
trajectoryGit, and qdrantTune schemas are added in subsequent tasks. During
migration, `index.ts` temporarily uses both old and new config fields.

**Step 4: Run tests — expect PASS**

```bash
npx vitest run tests/bootstrap/config.test.ts
```

**Step 5: Commit**

```bash
git add src/bootstrap/config.ts tests/bootstrap/config.test.ts
git commit -m "feat(config): zod schema for core + embedding slices"
```

---

### Task 2: Zod Config Schema — Ingest + Trajectory + Qdrant Tune

**Files:**

- Modify: `src/bootstrap/config.ts`
- Test: `tests/bootstrap/config.test.ts`

**Step 1: Add failing tests for ingest, trajectoryGit, qdrantTune slices**

```ts
describe("parseAppConfig — ingest", () => {
  beforeEach(cleanEnv);
  afterEach(cleanEnv);

  it("returns ingest defaults", async () => {
    const { parseAppConfig } = await import("../../src/bootstrap/config.js");
    const config = parseAppConfig();
    expect(config.ingest.chunkSize).toBe(2500);
    expect(config.ingest.chunkOverlap).toBe(300);
    expect(config.ingest.enableAST).toBe(true);
    expect(config.ingest.enableHybrid).toBe(false);
    expect(config.ingest.defaultSearchLimit).toBe(5);
  });

  it("reads INGEST_CHUNK_SIZE with CODE_CHUNK_SIZE fallback", async () => {
    process.env.CODE_CHUNK_SIZE = "1000";
    const { parseAppConfig } = await import("../../src/bootstrap/config.js");
    const result = parseAppConfig();
    expect(result.ingest.chunkSize).toBe(1000);
    expect(result.deprecations).toContainEqual({
      oldName: "CODE_CHUNK_SIZE",
      newName: "INGEST_CHUNK_SIZE",
    });
  });

  it("returns ingest tune defaults", async () => {
    const { parseAppConfig } = await import("../../src/bootstrap/config.js");
    const config = parseAppConfig();
    expect(config.ingest.tune.chunkerPoolSize).toBe(4);
    expect(config.ingest.tune.fileConcurrency).toBe(50);
    expect(config.ingest.tune.ioConcurrency).toBe(50);
  });
});

describe("parseAppConfig — trajectoryGit", () => {
  beforeEach(cleanEnv);
  afterEach(cleanEnv);

  it("returns trajectory defaults", async () => {
    const { parseAppConfig } = await import("../../src/bootstrap/config.js");
    const config = parseAppConfig();
    expect(config.trajectoryGit.enabled).toBe(false);
    expect(config.trajectoryGit.logMaxAgeMonths).toBe(12);
    expect(config.trajectoryGit.logTimeoutMs).toBe(60000);
    expect(config.trajectoryGit.chunkConcurrency).toBe(10);
    expect(config.trajectoryGit.squashAwareSessions).toBe(false);
    expect(config.trajectoryGit.sessionGapMinutes).toBe(30);
  });
});

describe("parseAppConfig — qdrantTune", () => {
  beforeEach(cleanEnv);
  afterEach(cleanEnv);

  it("returns qdrant tune defaults", async () => {
    const { parseAppConfig } = await import("../../src/bootstrap/config.js");
    const config = parseAppConfig();
    expect(config.qdrantTune.upsertBatchSize).toBe(100);
    expect(config.qdrantTune.upsertFlushIntervalMs).toBe(500);
    expect(config.qdrantTune.upsertOrdering).toBe("weak");
    expect(config.qdrantTune.deleteBatchSize).toBe(500);
    expect(config.qdrantTune.deleteConcurrency).toBe(8);
    expect(config.qdrantTune.deleteFlushTimeoutMs).toBe(1000);
  });
});
```

**Step 2: Run tests — FAIL (schemas not yet added)**

**Step 3: Add ingestSchema, trajectoryGitSchema, qdrantTuneSchema to config.ts**

Add after embeddingSchema:

```ts
const ingestTuneSchema = z.object({
  chunkerPoolSize: envInt(
    4,
    "INGEST_TUNE_CHUNKER_POOL_SIZE",
    "CHUNKER_POOL_SIZE",
  ),
  fileConcurrency: envInt(
    50,
    "INGEST_TUNE_FILE_CONCURRENCY",
    "FILE_PROCESSING_CONCURRENCY",
  ),
  ioConcurrency: envInt(50, "INGEST_TUNE_IO_CONCURRENCY", "MAX_IO_CONCURRENCY"),
});

const ingestSchema = z.object({
  chunkSize: envInt(2500, "INGEST_CHUNK_SIZE", "CODE_CHUNK_SIZE"),
  chunkOverlap: envInt(300, "INGEST_CHUNK_OVERLAP", "CODE_CHUNK_OVERLAP"),
  enableAST: envBool(true, "INGEST_ENABLE_AST", "CODE_ENABLE_AST"),
  enableHybrid: envBool(false, "INGEST_ENABLE_HYBRID", "CODE_ENABLE_HYBRID"),
  defaultSearchLimit: envInt(
    5,
    "INGEST_DEFAULT_SEARCH_LIMIT",
    "CODE_SEARCH_LIMIT",
  ),
  tune: ingestTuneSchema,
});

const trajectoryGitSchema = z.object({
  enabled: envBool(false, "TRAJECTORY_GIT_ENABLED", "CODE_ENABLE_GIT_METADATA"),
  logMaxAgeMonths: envFloat(
    12,
    "TRAJECTORY_GIT_LOG_MAX_AGE_MONTHS",
    "GIT_LOG_MAX_AGE_MONTHS",
  ),
  logTimeoutMs: envInt(
    60000,
    "TRAJECTORY_GIT_LOG_TIMEOUT_MS",
    "GIT_LOG_TIMEOUT_MS",
  ),
  chunkConcurrency: envInt(
    10,
    "TRAJECTORY_GIT_CHUNK_CONCURRENCY",
    "GIT_CHUNK_CONCURRENCY",
  ),
  chunkMaxAgeMonths: envFloat(
    6,
    "TRAJECTORY_GIT_CHUNK_MAX_AGE_MONTHS",
    "GIT_CHUNK_MAX_AGE_MONTHS",
  ),
  chunkTimeoutMs: envInt(
    120000,
    "TRAJECTORY_GIT_CHUNK_TIMEOUT_MS",
    "GIT_CHUNK_TIMEOUT_MS",
  ),
  chunkMaxFileLines: envInt(
    10000,
    "TRAJECTORY_GIT_CHUNK_MAX_FILE_LINES",
    "GIT_CHUNK_MAX_FILE_LINES",
  ),
  squashAwareSessions: envBool(false, "TRAJECTORY_GIT_SQUASH_AWARE_SESSIONS"),
  sessionGapMinutes: envInt(30, "TRAJECTORY_GIT_SESSION_GAP_MINUTES"),
});

const qdrantTuneSchema = z.object({
  upsertBatchSize: envInt(
    100,
    "QDRANT_TUNE_UPSERT_BATCH_SIZE",
    "QDRANT_UPSERT_BATCH_SIZE",
    "CODE_BATCH_SIZE",
  ),
  upsertFlushIntervalMs: envInt(
    500,
    "QDRANT_TUNE_UPSERT_FLUSH_INTERVAL_MS",
    "QDRANT_FLUSH_INTERVAL_MS",
  ),
  upsertOrdering: z.preprocess(
    () =>
      envWithFallback("QDRANT_TUNE_UPSERT_ORDERING", "QDRANT_BATCH_ORDERING") ??
      "weak",
    z.enum(["weak", "medium", "strong"]),
  ),
  deleteBatchSize: envInt(
    500,
    "QDRANT_TUNE_DELETE_BATCH_SIZE",
    "QDRANT_DELETE_BATCH_SIZE",
    "DELETE_BATCH_SIZE",
  ),
  deleteConcurrency: envInt(
    8,
    "QDRANT_TUNE_DELETE_CONCURRENCY",
    "QDRANT_DELETE_CONCURRENCY",
    "DELETE_CONCURRENCY",
  ),
  deleteFlushTimeoutMs: envInt(
    1000,
    "QDRANT_TUNE_DELETE_FLUSH_TIMEOUT_MS",
    "DELETE_FLUSH_TIMEOUT_MS",
  ),
});
```

Update appConfigSchema to include all slices. Export all types.

**Step 4: Run tests — PASS**

**Step 5: Commit**

```bash
git commit -m "feat(config): add ingest, trajectoryGit, qdrantTune zod slices"
```

---

### Task 3: Migrate index.ts + factory.ts to new config shape

**Files:**

- Modify: `src/index.ts`
- Modify: `src/bootstrap/factory.ts`
- Modify: `src/bootstrap/config.ts` (remove old `validateConfig`, old
  `AppConfig`)
- Test: existing tests still pass

**Step 1: Write failing test for printDeprecationWarnings call**

```ts
it("printDeprecationWarnings outputs to stderr", async () => {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  const { printDeprecationWarnings } =
    await import("../../src/bootstrap/config.js");
  printDeprecationWarnings([{ oldName: "OLD", newName: "NEW" }]);
  expect(spy).toHaveBeenCalledWith(expect.stringContaining("OLD → NEW"));
  spy.mockRestore();
});
```

**Step 2: Run — FAIL**

**Step 3: Update index.ts to use new config shape**

```ts
// src/index.ts
import {
  parseAppConfig,
  printDeprecationWarnings,
} from "./bootstrap/config.js";
import {
  createAppContext,
  createConfiguredServer,
  loadPrompts,
} from "./bootstrap/factory.js";
import { checkOllamaAvailability } from "./bootstrap/ollama.js";
import { startHttpServer } from "./bootstrap/transport/http.js";
import { startStdioServer } from "./bootstrap/transport/stdio.js";

async function main() {
  const config = parseAppConfig();
  printDeprecationWarnings(config.deprecations);
  await checkOllamaAvailability(config.embedding.provider);

  const ctx = createAppContext(config);
  const promptsConfig = loadPrompts(config);

  if (config.core.transportMode === "http") {
    await startHttpServer({ config, ctx, promptsConfig });
  } else {
    const server = createConfiguredServer(ctx, promptsConfig);
    await startStdioServer(server);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error instanceof Error ? error.message : error);
  process.exit(1);
});
```

Update `factory.ts` to read from config slices:

- `config.core.qdrantUrl` instead of `config.qdrantUrl`
- `EmbeddingProviderFactory.create(config.embedding)` instead of
  `.createFromEnv()`
- Pass config slices to IngestFacade, SearchFacade

Remove old `validateConfig()` and old `AppConfig` interface from config.ts.

**Step 4: Run full test suite**

```bash
npx vitest run
```

**Step 5: Commit**

```bash
git commit -m "refactor(bootstrap): migrate index.ts + factory.ts to zod config"
```

---

### Task 4: DI — Embedding adapters

**Files:**

- Modify: `src/core/adapters/embeddings/factory.ts` — delete `createFromEnv()`,
  `create()` accepts `EmbeddingConfig`
- Modify: `src/core/adapters/embeddings/ollama.ts` — receive `ollamaLegacyApi` +
  `ollamaNumGpu` via constructor, remove `process.env` reads
- Test: existing embedding tests

**Step 1: Write test that factory.create accepts EmbeddingConfig**

```ts
it("creates ollama provider from EmbeddingConfig", () => {
  const config = {
    provider: "ollama" as const,
    model: "test-model",
    ollamaLegacyApi: false,
    ollamaNumGpu: 999,
    tune: {
      concurrency: 1,
      batchSize: 1024,
      batchTimeoutMs: 2000,
      retryAttempts: 3,
      retryDelayMs: 1000,
    },
  };
  const provider = EmbeddingProviderFactory.create(config);
  expect(provider).toBeDefined();
});
```

**Step 2: Run — FAIL (create doesn't accept this shape)**

**Step 3: Update factory.ts to accept EmbeddingConfig, remove createFromEnv()**

Update `create()` to read fields from `EmbeddingConfig` instead of
`FactoryConfig`. Delete `createFromEnv()` entirely — all env parsing now in
bootstrap/config.ts. Update ollama.ts constructor to accept `legacyApi: boolean`
and `numGpu: number` instead of reading process.env.

**Step 4: Run full suite — PASS**

**Step 5: Commit**

```bash
git commit -m "refactor(embeddings): DI config slice, remove createFromEnv"
```

---

### Task 5: DI — Qdrant adapters

**Files:**

- Modify: `src/core/adapters/qdrant/accumulator.ts` — `createAccumulator()`
  accepts `QdrantTuneConfig`
- Modify: `src/core/adapters/qdrant/client.ts` — constructor accepts delete
  config from `QdrantTuneConfig`
- Modify: `src/bootstrap/factory.ts` — pass `config.qdrantTune`
- Test: existing qdrant tests

**Step 1: Write test**

```ts
it("createAccumulator uses config instead of process.env", () => {
  const config = {
    upsertBatchSize: 77,
    upsertFlushIntervalMs: 100,
    upsertOrdering: "weak" as const,
  };
  const acc = createAccumulator(mockQdrant, "test", false, config);
  // Verify via stats or internal state
});
```

**Step 2: Run — FAIL**

**Step 3: Update accumulator.ts and client.ts**

- `createAccumulator(qdrant, collection, isHybrid, config: QdrantTuneConfig)` —
  reads from config object, no process.env
- `QdrantManager` constructor accepts optional delete config

**Step 4: Run full suite — PASS**

**Step 5: Commit**

```bash
git commit -m "refactor(qdrant): DI config slice for accumulator + client"
```

---

### Task 6: DI — Ingest pipeline

**Files:**

- Modify: `src/core/ingest/pipeline/types.ts` — `DEFAULT_CONFIG` becomes
  `buildPipelineConfig(embedding, qdrantTune, ingest)`
- Modify: `src/core/ingest/pipeline/base.ts` — receive chunkerPoolSize from
  config
- Modify: `src/core/ingest/pipeline/file-processor.ts` — receive fileConcurrency
  from config
- Modify: `src/core/ingest/pipeline/infra/parallel.ts` — receive ioConcurrency
  from config
- Modify: `src/core/ingest/sync/parallel-synchronizer.ts` — receive config
  slices
- Test: existing pipeline tests

**Step 1: Write test for buildPipelineConfig**

```ts
it("buildPipelineConfig uses typed slices", () => {
  const config = buildPipelineConfig(
    embeddingSlice,
    qdrantTuneSlice,
    ingestSlice,
  );
  expect(config.workerPool.concurrency).toBe(embeddingSlice.tune.concurrency);
  expect(config.upsertAccumulator.batchSize).toBe(
    embeddingSlice.tune.batchSize,
  );
  expect(config.deleteAccumulator.batchSize).toBe(
    qdrantTuneSlice.deleteBatchSize,
  );
});
```

**Step 2: Run — FAIL**

**Step 3: Implement buildPipelineConfig, update constructors**

Replace `DEFAULT_CONFIG` const (with 16 process.env reads) with
`buildPipelineConfig()` function that accepts typed slices. Update
`BaseIndexingPipeline`, `processRelativeFiles`, `createParallelLimiter` to
accept config values via parameters.

**Step 4: Run full suite — PASS**

**Step 5: Commit**

```bash
git commit -m "refactor(ingest): DI config slices for pipeline, remove process.env"
```

---

### Task 7: DI — Trajectory git

**Files:**

- Modify: `src/core/trajectory/git/provider.ts` — constructor accepts
  `TrajectoryGitConfig`
- Modify: `src/core/trajectory/git/infra/file-reader.ts` — accept
  timeouts/maxAge from config
- Modify: `src/core/trajectory/git/infra/chunk-reader.ts` — accept maxFileLines
  from config
- Modify: `src/core/adapters/git/client.ts` — accept timeout from caller, not
  env
- Test: existing trajectory tests

**Step 1: Write test**

```ts
it("GitEnrichmentProvider reads concurrency from config", () => {
  const config = { chunkConcurrency: 20, chunkMaxAgeMonths: 3 /* ... */ };
  const provider = new GitEnrichmentProvider(config);
  // buildChunkSignals should use config.chunkConcurrency
});
```

**Step 2: Run — FAIL**

**Step 3: Update provider.ts + readers + client.ts**

- `GitEnrichmentProvider` constructor:
  `(config: TrajectoryGitConfig, squashOpts?)` instead of reading process.env
- `buildFileSignalMap` accepts `maxAgeMonths` and `timeoutMs` parameters
  (already has optional `maxAgeMonths`, add `timeoutMs`)
- `buildChunkChurnMap` already accepts `concurrency` and `maxAgeMonths` — no
  change needed
- `getCommitsByPathspec` in client.ts: accept `timeoutMs` parameter instead of
  reading env
- Remove all `process.env.TRAJECTORY_GIT_*` reads from trajectory module

**Step 4: Run full suite — PASS**

**Step 5: Commit**

```bash
git commit -m "refactor(trajectory): DI config slice, remove process.env"
```

---

### Task 8: DI — Debug flag

**Files:**

- Modify: ~12 files that read `process.env.DEBUG` — receive `debug` boolean
- Key files: `reindexing.ts`, `chunk-pipeline.ts`, `pipeline-manager.ts`,
  `worker-pool.ts`, `batch-accumulator.ts`, `pool.ts`,
  `parallel-synchronizer.ts`, `synchronizer.ts`, `deletion-strategy.ts`,
  `coordinator.ts`, `applier.ts`, `file-processor.ts`, `tree-sitter.ts`

**Strategy:** Two categories:

1. **Module-level `const DEBUG`** (7 files: chunk-pipeline, pipeline-manager,
   worker-pool, batch-accumulator, pool, parallel-synchronizer, debug-logger) —
   these initialize at module load. Change to function that reads from config.
2. **Inline `if (process.env.DEBUG)`** (8 files: reindexing, synchronizer,
   deletion-strategy, coordinator, applier, file-processor, indexing,
   tree-sitter) — pass debug flag through call chain or use a shared getter.

**Approach:** Create `src/core/ingest/pipeline/infra/runtime.ts` — tiny module
that holds runtime config set once at init:

```ts
let _debug = false;
export function setDebug(value: boolean): void {
  _debug = value;
}
export function isDebug(): boolean {
  return _debug;
}
```

Called from factory.ts at startup: `setDebug(config.core.debug)`. All files
replace `process.env.DEBUG` / `const DEBUG = ...` with `isDebug()`.

This avoids changing every function signature for a cross-cutting concern.

**Step 1: Write test for isDebug/setDebug**

**Step 2: Run — FAIL**

**Step 3: Implement runtime.ts, update all DEBUG readers**

**Step 4: Run full suite — PASS**

**Step 5: Commit**

```bash
git commit -m "refactor(debug): centralize DEBUG flag via runtime.ts"
```

---

### Task 9: Debug logger — getConfigDump

**Files:**

- Modify: `src/core/ingest/pipeline/infra/debug-logger.ts` — replace manual ENV
  dump with `getConfigDump()`
- Test: `tests/core/ingest/pipeline/debug-logger.test.ts`

**Step 1: Write test**

```ts
it("dumpEnvironment uses getConfigDump", () => {
  // Verify logger outputs parsed config values, not raw env vars
});
```

**Step 2: Run — FAIL**

**Step 3: Update debug-logger dumpEnvironment to call getConfigDump()**

Remove the ~30-line manual env var listing. Replace with:

```ts
import { getConfigDump } from "../../../../bootstrap/config.js";

// In dumpEnvironment():
const dump = getConfigDump(config);
for (const [key, value] of Object.entries(dump)) {
  this.writeRaw(`  ${key}: ${value}`);
}
```

**Step 4: Run full suite — PASS**

**Step 5: Commit**

```bash
git commit -m "refactor(debug-logger): use getConfigDump instead of manual env listing"
```

---

### Task 10: Cleanup — remove old env test files, verify zero process.env in src/

**Files:**

- Delete or simplify: `tests/bootstrap/server-env.test.ts`,
  `qdrant-tune-env.test.ts`, `embedding-tune-env.test.ts`, `ingest-env.test.ts`,
  `trajectory-git-env.test.ts`
- These are now redundant — `config.test.ts` covers all fallback chains

**Step 1: Verify zero process.env reads in src/ (except bootstrap/config.ts)**

```bash
rg "process\.env\." src/ --glob '!src/bootstrap/config.ts' -l
```

Expected: empty (or only `src/bootstrap/ollama.ts` which reads
`EMBEDDING_PROVIDER` — migrate too).

**Step 2: Delete redundant test files**

**Step 3: Run full suite — PASS**

**Step 4: Commit**

```bash
git commit -m "chore: remove redundant env test files, verify zero process.env in modules"
```

---

### Task 11: Final verification

**Step 1: Run full test suite**

```bash
npx vitest run
```

**Step 2: Run type check**

```bash
npx tsc --noEmit
```

**Step 3: Verify grep**

```bash
rg "process\.env\." src/ --glob '!src/bootstrap/config.ts' -c
```

Expected: 0 matches (except possibly bootstrap/ollama.ts if not migrated).

**Step 4: Final commit if any stragglers**

```bash
git commit -m "chore(config): final cleanup, zero process.env outside bootstrap"
```
