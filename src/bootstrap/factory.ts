// src/bootstrap/factory.ts
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { getDaemonPaths, getStorageDir, type CodegraphDaemonPaths } from "../core/adapters/duckdb/daemon/index.js";
import { GraphDbClientPool } from "../core/adapters/duckdb/index.js";
import type { EmbeddingProvider } from "../core/adapters/embeddings/base.js";
import { EmbeddingProviderFactory } from "../core/adapters/embeddings/factory.js";
import { OllamaEmbeddings } from "../core/adapters/embeddings/ollama.js";
import { QdrantManager } from "../core/adapters/qdrant/client.js";
import { DaemonLock } from "../core/adapters/qdrant/embedded/daemon-lock.js";
import { resolveQdrantUrl } from "../core/adapters/qdrant/embedded/daemon.js";
import {
  createApp,
  createComposition,
  ExploreFacade,
  IngestFacade,
  SchemaBuilder,
  type App,
} from "../core/api/index.js";
import { GraphFacade } from "../core/api/internal/facades/graph-facade.js";
import { ProjectRegistryOps } from "../core/api/internal/ops/project-registry-ops.js";
import { WorkerPoolEnrichmentExecutor } from "../core/domains/ingest/pipeline/enrichment/executor/index.js";
import { initDebugLogger, pipelineLog } from "../core/domains/ingest/pipeline/infra/debug-logger.js";
import { setDebug } from "../core/domains/ingest/pipeline/infra/runtime.js";
import { buildPipelineConfig } from "../core/domains/ingest/pipeline/types.js";
import { DefaultSymbolIdComposer } from "../core/domains/language/index.js";
import type { CodegraphDeps } from "../core/domains/trajectory/codegraph/index.js";
import { InMemoryGlobalSymbolTable } from "../core/domains/trajectory/codegraph/symbols/symbol-table.js";
import { EmbeddingModelGuard } from "../core/infra/embedding-model-guard.js";
import { CollectionRegistry } from "../core/infra/registry/index.js";
import { SchemaDriftMonitor } from "../core/infra/schema-drift-monitor.js";
import { StatsCache } from "../core/infra/stats-cache.js";
import type { HealthProbes } from "../mcp/middleware/error-handler.js";
import { loadPromptsConfig, type PromptsConfig } from "../mcp/prompts/index.js";
import { registerAllPrompts } from "../mcp/prompts/register.js";
import { registerAllResources } from "../mcp/resources/index.js";
import { registerAllTools } from "../mcp/tools/index.js";
import { applyEmbeddedDeleteTuning } from "./config/embedded-tuning.js";
import { getConfigDump, getZodConfig, type AppConfig } from "./config/index.js";
import { checkExternalQdrantVersion } from "./config/qdrant-compat.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf-8")) as {
  name: string;
  version: string;
};

export { pkg };

export interface AppContext {
  app: App;
  schemaBuilder: SchemaBuilder;
  healthProbes?: HealthProbes;
  embeddedRelease?: () => void;
  /** Graceful shutdown: terminate embedding provider + release embedded Qdrant. */
  cleanup?: () => void;
}

interface InfraContext {
  qdrant: QdrantManager;
  embeddings: EmbeddingProvider;
  modelGuard: EmbeddingModelGuard;
  embeddedRelease?: () => void;
}

interface CompositionContext {
  registry: ReturnType<typeof createComposition>["registry"];
  reranker: ReturnType<typeof createComposition>["reranker"];
  allPayloadSignalDescriptors: ReturnType<typeof createComposition>["allPayloadSignalDescriptors"];
  allStatsAccumulators: ReturnType<typeof createComposition>["allStatsAccumulators"];
  schemaBuilder: SchemaBuilder;
}

async function resolveInfrastructure(
  config: AppConfig,
  zodConfig: ReturnType<typeof getZodConfig>,
): Promise<InfraContext> {
  const resolution = await resolveQdrantUrl(config.qdrantUrl, config.paths.appData);
  if (resolution.mode === "external") {
    await checkExternalQdrantVersion(resolution.url, config.qdrantApiKey);
  }
  const reconnect = resolution.mode === "embedded" ? resolution.reconnect : undefined;
  const daemon =
    resolution.mode === "embedded"
      ? {
          startupPhase: resolution.startupPhase,
          pid: resolution.pid,
          storagePath: resolution.storagePath,
        }
      : undefined;
  const qdrant = new QdrantManager(resolution.url, config.qdrantApiKey, reconnect, daemon);
  const embeddedRelease = resolution.mode === "embedded" ? resolution.release : undefined;

  // Initialize debug logger with DI paths before any pipeline work
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

  // Wire Ollama fallback observability into pipeline debug log
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

  // Eagerly init ONNX to get calibrated batch size before pipeline config
  if ("initialize" in embeddings && typeof embeddings.initialize === "function") {
    await (embeddings as { initialize: () => Promise<void> }).initialize();
  }

  // If user didn't explicitly set batch size, use GPU-calibrated recommendation
  if (
    !zodConfig.flags.userSetBatchSize &&
    "recommendedBatchSize" in embeddings &&
    typeof embeddings.recommendedBatchSize === "number"
  ) {
    zodConfig.embedding.tune.batchSize = embeddings.recommendedBatchSize;
  }

  Object.assign(
    zodConfig.qdrantTune,
    applyEmbeddedDeleteTuning(zodConfig.qdrantTune, resolution.mode, {
      deleteBatchSize: zodConfig.flags.userSetDeleteBatchSize,
      deleteConcurrency: zodConfig.flags.userSetDeleteConcurrency,
    }),
  );

  const modelGuard = new EmbeddingModelGuard(qdrant, embeddings.getModel(), embeddings.getDimensions());

  return { qdrant, embeddings, modelGuard, embeddedRelease };
}

function wireComposition(
  zodConfig: ReturnType<typeof getZodConfig>,
  trajectoryConfig: AppConfig["trajectoryIngest"],
  codegraph?: CodegraphDeps,
): CompositionContext {
  // Thread git provider config into composition so the registry surfaces a
  // fully-configured GitEnrichmentProvider via getAllEnrichmentProviders().
  // IngestFacade no longer constructs git inline — single source of truth is
  // the registry.
  const squashOpts = trajectoryConfig.squashAwareSessions
    ? { squashAwareSessions: true, sessionGapMinutes: trajectoryConfig.sessionGapMinutes ?? 30 }
    : undefined;
  const { registry, reranker, allPayloadSignalDescriptors, allStatsAccumulators } = createComposition({
    git: { config: zodConfig.trajectoryGit, squashOpts },
    codegraph,
  });
  const schemaBuilder = new SchemaBuilder(reranker);
  return { registry, reranker, allPayloadSignalDescriptors, allStatsAccumulators, schemaBuilder };
}

interface CodegraphContext {
  deps: CodegraphDeps;
  graphFacade: GraphFacade;
  pool: GraphDbClientPool;
}

const codegraphDaemonLock = new DaemonLock();

/** Cheap pid-liveness probe over the daemon's pid file (no Qdrant coupling). */
function isCodegraphDaemonAlive(paths: CodegraphDaemonPaths): boolean {
  if (!existsSync(paths.pidFile)) return false;
  try {
    const pid = parseInt(readFileSync(paths.pidFile, "utf-8").trim(), 10);
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Lazily spawn the codegraph daemon process when it is not already alive. The
 * spawn is single-flighted across processes via `DaemonLock` on the lock file —
 * mirrors the Qdrant embedded-daemon cold-spawn guard. The daemon binary is the
 * built `entry.js` next to this module; resolved via `import.meta.url` so it
 * works identically under `src/` (ts-node) and `build/` (shipped JS).
 *
 * The daemon is the default (only) write path — there is no in-process RW
 * fallback. A spawn failure here is swallowed, but the subsequent
 * `DaemonGraphDbClient.init()` then surfaces the connect failure loudly after
 * its bounded retry window expires, rather than silently degrading.
 *
 * Refcounting is intentionally NOT done here. The daemon's per-connection
 * refcount is owned SOLELY by `entry.ts` (connect = +1, socket close = -1), so
 * `refs` equals the number of live `(collection, process)` sockets. The pool
 * caches one socket per collection and closes them in `closeAll`, so when a
 * client process exits or shuts down its pool the sockets close, `refs` decays
 * to 0, and the idle watcher releases the RW lock. A per-process bump here
 * would double-count (the connections already counted) and pin `refs` above 0
 * forever — the exact bug that kept the daemon holding the lock.
 */
function ensureCodegraphDaemon(
  paths: CodegraphDaemonPaths,
  rootDir: string,
  resources: {
    memoryLimit?: string;
    threads?: number;
  },
): void {
  if (isCodegraphDaemonAlive(paths)) return;
  const lock = codegraphDaemonLock.acquire(paths.lockFile);
  if (!lock) return; // another process is spawning; it will own the daemon
  try {
    if (isCodegraphDaemonAlive(paths)) return;
    const entryUrl = new URL("../core/adapters/duckdb/daemon/entry.js", import.meta.url);
    const entryPath = fileURLToPath(entryUrl);
    const child = spawn(process.execPath, [entryPath], {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        TEA_RAGS_CODEGRAPH_DAEMON_ROOT: rootDir,
        TEA_RAGS_CODEGRAPH_DAEMON_DIR: paths.storageDir,
        ...(resources.memoryLimit ? { TEA_RAGS_CODEGRAPH_DAEMON_MEMORY: resources.memoryLimit } : {}),
        ...(resources.threads !== undefined ? { TEA_RAGS_CODEGRAPH_DAEMON_THREADS: String(resources.threads) } : {}),
      },
    });
    child.unref();
  } catch {
    /* best-effort: fall back to in-process write path */
  } finally {
    codegraphDaemonLock.release(lock.fd);
  }
}

export function wireCodegraph(
  config: AppConfig,
  zodConfig: ReturnType<typeof getZodConfig>,
  collectionRegistry: CollectionRegistry,
  /**
   * Expand a Qdrant alias to its active versioned collection for the codegraph
   * read path (GraphFacade) — the DuckDB files are versioned but the project
   * addresses the stable alias. Wired to `qdrant.aliases.resolveActive` by
   * `createAppContext`. Optional: the wireCodegraph unit test omits it (reads
   * then address by literal collection, no alias indirection needed).
   */
  resolveActiveCollection?: (collectionName: string) => Promise<string>,
): CodegraphContext | undefined {
  // Defensive: legacy/mocked configs may omit the codegraph section
  // entirely. Treat that as "disabled" so the `codegraph.enabled` config
  // flag stays the single switch for the feature.
  const { codegraph } = zodConfig;
  if (!codegraph?.enabled) return undefined;

  // Per-collection DuckDB layout: `<rootDir>/codegraph/<collection>.duckdb`.
  // The legacy `CODEGRAPH_DB_PATH` env var, when it points at a
  // directory, is honoured as the rootDir override; pointing at a
  // single file is no longer meaningful under per-collection routing
  // and is treated as the parent directory's leaf override. Default
  // is `paths.appData` so existing installs find their data in the
  // same place.
  const rootDir = codegraph.dbPath
    ? codegraph.dbPath.endsWith(".duckdb")
      ? dirname(codegraph.dbPath)
      : codegraph.dbPath
    : config.paths.appData;

  // The daemon is the default (and only) write path — base functionality for
  // cross-process single-writer lock safety, not opt-in. The pool is always
  // told the daemon's unix socket so `acquireWrite` proxies mutations to the
  // single daemon process (one RW DuckDB lock per machine). The daemon process
  // itself is spawned lazily on the first write (see lazy wrap below) so this
  // wire step stays side-effect-free — merely wiring (no write) never spawns,
  // which is what keeps the unit suite from launching a real daemon.
  const daemonPaths = getDaemonPaths(getStorageDir(rootDir));

  const ambiguousMode = codegraph.ambiguousResolveMode;
  // Single cross-language symbolId mapper injected into every codegraph
  // symbolId-building consumer (the provider's joinSymbol + the native
  // resolvers). bootstrap/ is the composition layer that may import the
  // concrete; the consumers type it as the contracts `SymbolIdComposer`
  // interface, so the `trajectory/** -> domains/language/**` leaf-domain guard
  // holds. See spec §1a + `.claude/rules/symbolid-convention.md`.
  const symbolIdComposer = new DefaultSymbolIdComposer();
  // Every source language with a codegraph resolver — typescript + javascript +
  // python + ruby + go + java + rust + bash — is served by its NATIVE
  // domains/language/<lang> provider (its own TSCallResolver / … built with
  // `ambiguousMode` threaded via CodegraphDeps). The provider reaches each
  // resolver via `factory.create(lang).resolver`; there is no separate resolver
  // map to thread (the legacy adapter that consumed one was removed by
  // tea-rags-mcp-jh40).

  const pool = new GraphDbClientPool({
    rootDir,
    symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
    // Slice 2 resource ceiling — caps per-collection DuckDB memory at
    // CODEGRAPH_DB_MEMORY_LIMIT (default 2GB) with disk spill into
    // `<rootDir>/codegraph/.spill/`. Without the cap DuckDB defaults
    // to ~80% of system RAM which on large repos pushes the indexing
    // pass OOM (14.3GB seen on ugnest = 5574 files before the cap).
    // `preserveInsertionOrder: false` lets the driver reorder rows
    // for memory wins; cg_symbols queries that need order use ORDER
    // BY explicitly.
    resources: {
      memoryLimit: codegraph.dbMemoryLimit,
      threads: codegraph.dbThreads,
      preserveInsertionOrder: false,
    },
    // Daemon socket — always set. `acquireWrite` routes mutations through a
    // `DaemonGraphDbClient` over this socket; reads (`acquireRead`) always stay
    // in-process READ_ONLY and ignore it.
    daemonSocketPath: daemonPaths.socketPath,
    // Hydrate the per-collection symbol table from disk on first open.
    // Without this, an incremental reindex of file A cannot resolve
    // calls into an unchanged file B — the walker only touches changed
    // files, so B's symbols would be invisible. After hydration the
    // in-memory table holds every previously-persisted definition;
    // the streaming upsert path (sink.finish() → graphDb.upsertSymbols)
    // keeps it current. Empty result on first run (fresh DB) is the
    // no-op fast path.
    initHook: async ({ collectionName, graphDb, symbolTable }) => {
      try {
        const persisted = await graphDb.listAllSymbols();
        if (persisted.length > 0) symbolTable.hydrate(persisted);
      } catch (err) {
        process.stderr.write(
          `[tea-rags] codegraph symbol-table hydration failed for ${collectionName}: ${(err as Error).message}\n`,
        );
      }
    },
  });

  // Lazy spawn-on-demand: the daemon process is started the FIRST time a write
  // OR a read is acquired, not at wire time — so `wireCodegraph` stays
  // side-effect-free (the unit test exercises only the wire step and never
  // spawns). `ensureCodegraphDaemon` is single-flighted across processes via
  // DaemonLock and refcounts each MCP client; `ensured` makes the in-process
  // wrap fire once. The subsequent `DaemonGraphDbClient.init()` retries the
  // socket connect with bounded backoff, absorbing the detached-spawn → connect
  // race. BOTH `acquireWrite` and `acquireReader` must ensure the daemon
  // because in daemon mode the `DaemonGraphDbClient` is the sole accessor for
  // reads too — a query issued before any write would otherwise fail to
  // connect, and GraphFacade.withReadHandle would silently return empty.
  let ensured = false;
  const ensure = (): void => {
    if (ensured) return;
    ensured = true;
    ensureCodegraphDaemon(daemonPaths, rootDir, {
      memoryLimit: codegraph.dbMemoryLimit,
      threads: codegraph.dbThreads,
    });
  };
  const originalAcquireWrite = pool.acquireWrite.bind(pool);
  pool.acquireWrite = async (collectionName: string) => {
    ensure();
    return originalAcquireWrite(collectionName);
  };
  const originalAcquireReader = pool.acquireReader.bind(pool);
  pool.acquireReader = async (collectionName: string) => {
    ensure();
    return originalAcquireReader(collectionName);
  };

  const deps: CodegraphDeps = {
    pool,
    composer: symbolIdComposer,
    // Threaded to composition roots so NATIVE language providers (ruby, …) build
    // their resolver with the configured mode.
    ambiguousResolveMode: ambiguousMode,
    // Codegraph-layer exclusion (test files + user-supplied patterns).
    // The shape mirrors `CodegraphExclusionOptions`; the provider
    // builds the actual `Ignore` instance at construction time.
    exclusion: {
      excludeTests: codegraph.excludeTests,
      customPatterns: codegraph.customExcludePatterns ?? [],
    },
  };
  const graphFacade = new GraphFacade({ pool, collectionRegistry, resolveActiveCollection });
  return { deps, graphFacade, pool };
}

export async function createAppContext(config: AppConfig): Promise<AppContext> {
  const zodConfig = getZodConfig();
  setDebug(zodConfig.core.debug);

  const infra = await resolveInfrastructure(config, zodConfig);
  // Registry must exist before wireCodegraph because GraphFacade resolves
  // the `{ collection, project, path }` triad through it. startWatching()
  // is deferred until later — registry construction alone is side-effect
  // free, so creating it early costs nothing.
  const collectionRegistry = new CollectionRegistry(config.paths.appData);
  const codegraphContext = wireCodegraph(config, zodConfig, collectionRegistry, async (name) =>
    infra.qdrant.aliases.resolveActive(name),
  );
  const composition = wireComposition(zodConfig, config.trajectoryIngest, codegraphContext?.deps);

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

  const registryWatchStop = collectionRegistry.startWatching();
  // Registry is the single source of truth for enrichment providers. Git
  // is now constructed inside GitTrajectory at composition time with
  // proper config, so the registry returns a ready-to-use provider list.
  // Bootstrap applies the user-visible toggle (`enableGitMetadata`) here
  // rather than inside the facade — keeps IngestFacade free of provider
  // construction or config-aware filtering.
  const enrichmentProviders = composition.registry
    .getAllEnrichmentProviders()
    .filter((p) => p.key !== "git" || config.trajectoryIngest.enableGitMetadata);

  // Phase 2 of unified-enrichment-worker-pool plan. Production runs through
  // the worker-pool executor unconditionally so heavy trajectory work (git
  // blame, codegraph extraction) doesn't starve the embedding event loop.
  // `InlineEnrichmentExecutor` is the internal test seam — integration tests
  // construct IngestFacade directly with their own executor in deps when they
  // need to skip the worker spawn. Worker entry path resolves relative to the
  // compiled bootstrap module so both the npm-linked global install and the
  // local dev path work.
  const enrichmentExecutor = new WorkerPoolEnrichmentExecutor(
    zodConfig.ingest.tune.enrichmentPoolSize,
    join(dirname(fileURLToPath(import.meta.url)), "../core/domains/ingest/pipeline/enrichment/infra/worker.js"),
  );

  const ingest = new IngestFacade({
    qdrant: infra.qdrant,
    embeddings: infra.embeddings,
    config: config.ingestCode,
    trajectoryConfig: config.trajectoryIngest,
    statsCache,
    allPayloadSignals: composition.allPayloadSignalDescriptors,
    statsAccumulators: composition.allStatsAccumulators,
    reranker: composition.reranker,
    deleteConfig,
    pipelineTuning,
    syncTuning,
    snapshotDir: config.paths.snapshots,
    modelGuard: infra.modelGuard,
    collectionRegistry,
    teaRagsVersion: pkg.version,
    enrichmentProviders,
    codegraphPool: codegraphContext?.pool,
    enrichmentExecutor,
  });
  const essentialTrajectoryFields = composition.registry.getEssentialPayloadKeys();
  const schemaDriftMonitor = new SchemaDriftMonitor(statsCache, [
    ...composition.allPayloadSignalDescriptors.map((d) => d.key),
    "navigation",
  ]);
  const projectRegistryOps = new ProjectRegistryOps({
    registry: collectionRegistry,
    qdrant: infra.qdrant,
    embeddings: infra.embeddings,
    snapshotDir: config.paths.snapshots,
  });
  const explore = new ExploreFacade({
    qdrant: infra.qdrant,
    embeddings: infra.embeddings,
    reranker: composition.reranker,
    registry: composition.registry,
    collectionRegistry,
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
    projectRegistryOps,
    quantizationScalar: zodConfig.qdrantTune.quantizationScalar,
    modelGuard: infra.modelGuard,
    graphFacade: codegraphContext?.graphFacade,
    codegraphPool: codegraphContext?.pool,
    registeredProviderKeys: new Set(composition.registry.getRegisteredKeys()),
  });

  const cleanup = () => {
    registryWatchStop();
    if ("terminate" in infra.embeddings && typeof infra.embeddings.terminate === "function") {
      void (infra.embeddings as { terminate: () => Promise<void> }).terminate();
    }
    if (infra.embeddedRelease) {
      infra.embeddedRelease();
    }
    // Close every per-collection DuckDB the pool opened. Fire-and-forget:
    // shutdown is best-effort and DuckDB releases the file lock when the
    // GC sweeps the instance even if we miss the explicit close.
    if (codegraphContext) {
      void codegraphContext.pool.closeAll().catch(() => undefined);
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
      ...(infra.embeddings.getBaseUrl ? { embeddingUrl: infra.embeddings.getBaseUrl() } : {}),
    },
    embeddedRelease: infra.embeddedRelease,
    cleanup,
  };
}

export function loadPrompts(config: AppConfig): PromptsConfig | null {
  if (!existsSync(config.promptsConfigFile)) return null;
  try {
    const promptsConfig = loadPromptsConfig(config.promptsConfigFile);
    console.error(`Loaded ${promptsConfig.prompts.length} prompts from ${config.promptsConfigFile}`);
    return promptsConfig;
  } catch (error) {
    console.error(`Failed to load prompts configuration from ${config.promptsConfigFile}:`, error);
    process.exit(1);
  }
}

export function createConfiguredServer(ctx: AppContext, promptsConfig: PromptsConfig | null): McpServer {
  const server = new McpServer({
    name: pkg.name,
    version: pkg.version,
  });

  registerAllTools(server, {
    app: ctx.app,
    schemaBuilder: ctx.schemaBuilder,
    healthProbes: ctx.healthProbes,
  });
  registerAllResources(server, ctx.app);
  registerAllPrompts(server, promptsConfig);

  return server;
}
