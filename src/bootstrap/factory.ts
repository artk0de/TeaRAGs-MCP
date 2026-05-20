// src/bootstrap/factory.ts
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { DuckDbGraphClient } from "../core/adapters/duckdb/index.js";
import type { EmbeddingProvider } from "../core/adapters/embeddings/base.js";
import { EmbeddingProviderFactory } from "../core/adapters/embeddings/factory.js";
import { OllamaEmbeddings } from "../core/adapters/embeddings/ollama.js";
import { QdrantManager } from "../core/adapters/qdrant/client.js";
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
import type { CallResolver } from "../core/contracts/types/codegraph.js";
import { initDebugLogger, pipelineLog } from "../core/domains/ingest/pipeline/infra/debug-logger.js";
import { setDebug } from "../core/domains/ingest/pipeline/infra/runtime.js";
import { buildPipelineConfig } from "../core/domains/ingest/pipeline/types.js";
import type { CodegraphDeps } from "../core/domains/trajectory/codegraph/index.js";
import { loadTsConfig, TSCallResolver } from "../core/domains/trajectory/codegraph/symbols/resolvers/ts/index.js";
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

function wireComposition(codegraph?: CodegraphDeps): CompositionContext {
  const { registry, reranker, allPayloadSignalDescriptors, allStatsAccumulators } = createComposition({
    codegraph,
  });
  const schemaBuilder = new SchemaBuilder(reranker);
  return { registry, reranker, allPayloadSignalDescriptors, allStatsAccumulators, schemaBuilder };
}

interface CodegraphContext {
  deps: CodegraphDeps;
  graphFacade: GraphFacade;
  graphDb: DuckDbGraphClient;
}

async function wireCodegraph(
  config: AppConfig,
  zodConfig: ReturnType<typeof getZodConfig>,
): Promise<CodegraphContext | undefined> {
  // Defensive: legacy/mocked configs may omit the codegraph section
  // entirely. Treat that as "disabled" so opt-in via env stays the
  // only path to enable codegraph.
  const { codegraph } = zodConfig;
  if (!codegraph?.enabled) return undefined;

  const dbPath = codegraph.dbPath ?? join(config.paths.appData, "codegraph.duckdb");
  const graphDb = new DuckDbGraphClient({ path: dbPath });
  await graphDb.init();

  // Apply slice 1 schema. Migrations are idempotent — safe to re-run on
  // every bootstrap. The runner consumes an inline array of
  // `{ filename, sql }` so the compiled `build/` artifact ships them
  // as plain JS (no SQL files to copy alongside the TS output).
  const { runMigrations } = await import("../core/infra/migration/database/runner.js");
  const { DATABASE_MIGRATIONS } = await import("../core/infra/migration/database/migrations/index.js");
  await runMigrations(graphDb, DATABASE_MIGRATIONS);

  const tsOptions = loadTsConfig(process.cwd());
  const resolvers = new Map<string, CallResolver>([["typescript", new TSCallResolver(tsOptions)]]);

  const deps: CodegraphDeps = {
    graphDb,
    symbolTable: new InMemoryGlobalSymbolTable(),
    resolvers,
  };
  const graphFacade = new GraphFacade({ graphDb });
  return { deps, graphFacade, graphDb };
}

export async function createAppContext(config: AppConfig): Promise<AppContext> {
  const zodConfig = getZodConfig();
  setDebug(zodConfig.core.debug);

  const infra = await resolveInfrastructure(config, zodConfig);
  const codegraphContext = await wireCodegraph(config, zodConfig);
  const composition = wireComposition(codegraphContext?.deps);

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

  const collectionRegistry = new CollectionRegistry(config.paths.appData);
  const registryWatchStop = collectionRegistry.startWatching();
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
  });

  const cleanup = () => {
    registryWatchStop();
    if ("terminate" in infra.embeddings && typeof infra.embeddings.terminate === "function") {
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
