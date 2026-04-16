# createAppContext Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `createAppContext()` into phase functions and replace
`IngestFacade` 12 positional args with a deps object.

**Architecture:** Extract `resolveInfrastructure()` and `wireComposition()` from
`createAppContext()`. Introduce `IngestFacadeDeps` interface. Update all ~25
call sites in tests.

**Tech Stack:** TypeScript, Vitest

**Spec:**
`docs/superpowers/specs/2026-04-16-createAppContext-refactor-design.md`

---

### Task 1: Introduce IngestFacadeDeps interface

**Files:**

- Modify: `src/core/api/internal/facades/ingest-facade.ts:61-126`
- Test: `tests/bootstrap/factory.test.ts` (existing — verify still passes)

- [ ] **Step 1: Define IngestFacadeDeps interface and refactor constructor**

Add the interface above the class, then change the constructor to accept it:

```typescript
// Add after line 60, before class IngestFacade
export interface IngestFacadeDeps {
  qdrant: QdrantManager;
  embeddings: EmbeddingProvider;
  config: IngestCodeConfig;
  trajectoryConfig: TrajectoryIngestConfig;
  statsCache?: StatsCache;
  allPayloadSignals?: PayloadSignalDescriptor[];
  reranker?: Reranker;
  deleteConfig?: DeletionConfig;
  pipelineTuning?: PipelineTuning;
  syncTuning?: SynchronizerTuning;
  snapshotDir?: string;
  modelGuard?: EmbeddingModelGuard;
}
```

Change constructor signature from 12 positional args to:

```typescript
constructor(deps: IngestFacadeDeps) {
  const {
    qdrant, embeddings, config, trajectoryConfig,
    statsCache, allPayloadSignals, reranker,
    deleteConfig, pipelineTuning, syncTuning, snapshotDir, modelGuard,
  } = deps;
  this.qdrant = qdrant;
  this.embeddings = embeddings;
  this.config = config;
  this.statsCache = statsCache;
  this.allPayloadSignals = allPayloadSignals;
  this.reranker = reranker;
  this.modelGuard = modelGuard;
  // ... rest of constructor body unchanged
```

Remove `private readonly` from constructor params — assign in body instead. Keep
all field declarations at top of class.

- [ ] **Step 2: Update factory.ts call site**

In `src/bootstrap/factory.ts:128-141`, change from positional args to deps
object:

```typescript
const ingest = new IngestFacade({
  qdrant,
  embeddings,
  config: config.ingestCode,
  trajectoryConfig: config.trajectoryIngest,
  statsCache,
  allPayloadSignals: allPayloadSignalDescriptors,
  reranker,
  deleteConfig,
  pipelineTuning,
  syncTuning,
  snapshotDir: config.paths.snapshots,
  modelGuard,
});
```

- [ ] **Step 3: Update test call sites**

All test files that use `new IngestFacade(...)` with positional args must switch
to deps object. There are ~25 call sites across these test files:

- `tests/core/api/ingest-facade.test.ts` (4 sites)
- `tests/integration/integration.test.ts` (3 sites)
- `tests/core/domains/ingest/indexing.test.ts` (10 sites)
- `tests/core/domains/ingest/indexer.test.ts` (1 site)
- `tests/core/domains/ingest/reindexing.test.ts` (1 site)
- `tests/core/domains/ingest/enrichment-module.test.ts` (8 sites)
- `tests/core/domains/ingest/enrichment-await.test.ts` (3 sites)
- `tests/core/domains/ingest/pipeline/enrichment/recovery-e2e.test.ts` (1 site)
- `tests/core/domains/ingest/pipeline/status-module.test.ts` (1 site)

Pattern: `new IngestFacade(qdrant as any, embeddings, config, trajectoryConfig)`
becomes
`new IngestFacade({ qdrant: qdrant as any, embeddings, config, trajectoryConfig })`.
Only the first 4 args are required in most test call sites — the rest are
optional.

- [ ] **Step 4: Run tests**

Run: `npx vitest run` Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add src/core/api/internal/facades/ingest-facade.ts src/bootstrap/factory.ts tests/
git commit -m "refactor(api): replace IngestFacade positional args with deps object"
```

### Task 2: Extract phase functions from createAppContext

**Files:**

- Modify: `src/bootstrap/factory.ts:50-190`
- Test: `tests/bootstrap/factory.test.ts` (existing — verify still passes)

- [ ] **Step 1: Define result types for phases**

Add above `createAppContext`:

```typescript
interface InfraContext {
  qdrant: QdrantManager;
  embeddings: EmbeddingProvider;
  modelGuard: EmbeddingModelGuard;
  embeddedRelease?: () => void;
}

interface CompositionContext {
  registry: ReturnType<typeof createComposition>["registry"];
  reranker: ReturnType<typeof createComposition>["reranker"];
  allPayloadSignalDescriptors: ReturnType<
    typeof createComposition
  >["allPayloadSignalDescriptors"];
  schemaBuilder: SchemaBuilder;
}
```

- [ ] **Step 2: Extract resolveInfrastructure()**

Extract lines 51-104 into:

```typescript
async function resolveInfrastructure(
  config: AppConfig,
  zodConfig: ReturnType<typeof getZodConfig>,
): Promise<InfraContext> {
  const resolution = await resolveQdrantUrl(
    config.qdrantUrl,
    config.paths.appData,
  );
  const reconnect =
    resolution.mode === "embedded" ? resolution.reconnect : undefined;
  const qdrant = new QdrantManager(
    resolution.url,
    config.qdrantApiKey,
    reconnect,
  );
  const embeddedRelease =
    resolution.mode === "embedded" ? resolution.release : undefined;

  initDebugLogger({
    logsDir: config.paths.logs,
    getConfigDump: () => {
      const { deprecations: _, ...configSections } = zodConfig;
      return getConfigDump(configSections);
    },
    getConcurrency: () => ({
      pipelineConcurrency: zodConfig.ingest.tune.pipelineConcurrency,
      chunkerPoolSize: zodConfig.ingest.tune.chunkerPoolSize,
      gitChunkConcurrency: zodConfig.trajectoryGit.chunkConcurrency,
    }),
  });

  const embeddings = EmbeddingProviderFactory.create(zodConfig.embedding, {
    models: config.paths.models,
    daemonSocket: config.paths.daemonSocket,
    daemonPid: config.paths.daemonPid,
  });

  if (embeddings instanceof OllamaEmbeddings) {
    embeddings.onFallbackSwitch = (event) => {
      const level = event.direction === "to-fallback" ? 1 : 0;
      pipelineLog.fallback(
        { component: "Ollama" },
        level,
        `${event.direction}: ${event.primaryUrl} → ${event.fallbackUrl} (${event.reason})`,
      );
    };
  }

  if (
    "initialize" in embeddings &&
    typeof embeddings.initialize === "function"
  ) {
    await (embeddings as { initialize: () => Promise<void> }).initialize();
  }

  if (
    !zodConfig.flags.userSetBatchSize &&
    "recommendedBatchSize" in embeddings &&
    typeof embeddings.recommendedBatchSize === "number"
  ) {
    zodConfig.embedding.tune.batchSize = embeddings.recommendedBatchSize;
  }

  const modelGuard = new EmbeddingModelGuard(
    qdrant,
    embeddings.getModel(),
    embeddings.getDimensions(),
  );

  return { qdrant, embeddings, modelGuard, embeddedRelease };
}
```

- [ ] **Step 3: Extract wireComposition()**

Extract lines 106-108:

```typescript
function wireComposition(): CompositionContext {
  const { registry, reranker, allPayloadSignalDescriptors } =
    createComposition();
  const schemaBuilder = new SchemaBuilder(reranker);
  return { registry, reranker, allPayloadSignalDescriptors, schemaBuilder };
}
```

- [ ] **Step 4: Rewrite createAppContext as orchestrator**

```typescript
export async function createAppContext(config: AppConfig): Promise<AppContext> {
  const zodConfig = getZodConfig();
  setDebug(zodConfig.core.debug);

  const infra = await resolveInfrastructure(config, zodConfig);
  const composition = wireComposition();

  const statsCache = new StatsCache(config.paths.snapshots);
  const deleteConfig = {
    batchSize: zodConfig.qdrantTune.deleteBatchSize,
    concurrency: zodConfig.qdrantTune.deleteConcurrency,
  };
  const pipelineConfig = buildPipelineConfig(
    zodConfig.ingest.tune.pipelineConcurrency,
    zodConfig.embedding.tune,
    zodConfig.qdrantTune,
  );
  const pipelineTuning = {
    pipelineConfig,
    chunkerPoolSize: zodConfig.ingest.tune.chunkerPoolSize,
    fileConcurrency: zodConfig.ingest.tune.fileConcurrency,
  };
  const syncTuning = {
    concurrency: zodConfig.ingest.tune.pipelineConcurrency,
    ioConcurrency: zodConfig.ingest.tune.ioConcurrency,
  };

  const ingest = new IngestFacade({
    qdrant: infra.qdrant,
    embeddings: infra.embeddings,
    config: config.ingestCode,
    trajectoryConfig: config.trajectoryIngest,
    statsCache,
    allPayloadSignals: composition.allPayloadSignalDescriptors,
    reranker: composition.reranker,
    deleteConfig,
    pipelineTuning,
    syncTuning,
    snapshotDir: config.paths.snapshots,
    modelGuard: infra.modelGuard,
  });

  const essentialTrajectoryFields =
    composition.registry.getEssentialPayloadKeys();
  const schemaDriftMonitor = new SchemaDriftMonitor(statsCache, [
    ...composition.allPayloadSignalDescriptors.map((d) => d.key),
    "navigation",
  ]);
  const explore = new ExploreFacade({
    qdrant: infra.qdrant,
    embeddings: infra.embeddings,
    reranker: composition.reranker,
    registry: composition.registry,
    statsCache,
    schemaDriftMonitor,
    payloadSignals: composition.allPayloadSignalDescriptors,
    essentialKeys: essentialTrajectoryFields,
    modelGuard: infra.modelGuard,
  });
  const app = createApp({
    qdrant: infra.qdrant,
    embeddings: infra.embeddings,
    ingest,
    explore,
    reranker: composition.reranker,
    schemaDriftMonitor,
    quantizationScalar: zodConfig.qdrantTune.quantizationScalar,
    modelGuard: infra.modelGuard,
  });

  const cleanup = () => {
    if (
      "terminate" in infra.embeddings &&
      typeof infra.embeddings.terminate === "function"
    ) {
      void (infra.embeddings as { terminate: () => Promise<void> }).terminate();
    }
    if (infra.embeddedRelease) {
      infra.embeddedRelease();
    }
  };

  return {
    app,
    schemaBuilder: composition.schemaBuilder,
    healthProbes: {
      checkQdrant: async () => infra.qdrant.checkHealth(),
      checkEmbedding: async () => infra.embeddings.checkHealth(),
      qdrantUrl: infra.qdrant.url,
      embeddingProvider: infra.embeddings.getProviderName(),
      ...(infra.embeddings.getBaseUrl
        ? { embeddingUrl: infra.embeddings.getBaseUrl() }
        : {}),
    },
    embeddedRelease: infra.embeddedRelease,
    cleanup,
  };
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run` Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add src/bootstrap/factory.ts
git commit -m "refactor(bootstrap): extract phase functions from createAppContext"
```
