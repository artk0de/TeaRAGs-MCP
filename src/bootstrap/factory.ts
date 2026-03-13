// src/bootstrap/factory.ts
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { EmbeddingProviderFactory } from "../core/adapters/embeddings/factory.js";
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
import { initDebugLogger } from "../core/domains/ingest/pipeline/infra/debug-logger.js";
import { setDebug } from "../core/domains/ingest/pipeline/infra/runtime.js";
import { buildPipelineConfig } from "../core/domains/ingest/pipeline/types.js";
import { SchemaDriftMonitor } from "../core/infra/schema-drift-monitor.js";
import { StatsCache } from "../core/infra/stats-cache.js";
import { loadPromptsConfig, type PromptsConfig } from "../mcp/prompts/index.js";
import { registerAllPrompts } from "../mcp/prompts/register.js";
import { registerAllResources } from "../mcp/resources/index.js";
import { registerAllTools } from "../mcp/tools/index.js";
import { getConfigDump, getZodConfig, type AppConfig } from "./config/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf-8")) as {
  name: string;
  version: string;
};

export { pkg };

export interface AppContext {
  app: App;
  schemaBuilder: SchemaBuilder;
  embeddedRelease?: () => void;
  /** Graceful shutdown: terminate embedding provider + release embedded Qdrant. */
  cleanup?: () => void;
}

export async function createAppContext(config: AppConfig): Promise<AppContext> {
  const resolution = await resolveQdrantUrl(config.qdrantUrl, config.paths.appData);
  const qdrant = new QdrantManager(resolution.url, config.qdrantApiKey);
  const embeddedRelease = resolution.mode === "embedded" ? resolution.release : undefined;
  const zodConfig = getZodConfig();
  setDebug(zodConfig.core.debug);

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

  const { registry, reranker, allPayloadSignalDescriptors } = createComposition();
  const essentialTrajectoryFields = registry.getEssentialPayloadKeys();
  const schemaBuilder = new SchemaBuilder(reranker);
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
  const ingest = new IngestFacade(
    qdrant,
    embeddings,
    config.ingestCode,
    config.trajectoryIngest,
    statsCache,
    allPayloadSignalDescriptors,
    reranker,
    deleteConfig,
    pipelineTuning,
    syncTuning,
    config.paths.snapshots,
  );
  const schemaDriftMonitor = new SchemaDriftMonitor(
    statsCache,
    allPayloadSignalDescriptors.map((d) => d.key),
  );
  const explore = new ExploreFacade({
    qdrant,
    embeddings,
    reranker,
    registry,
    statsCache,
    schemaDriftMonitor,
    payloadSignals: allPayloadSignalDescriptors,
    essentialKeys: essentialTrajectoryFields,
  });
  const app = createApp({
    qdrant,
    embeddings,
    ingest,
    explore,
    reranker,
    schemaDriftMonitor,
  });

  const cleanup = () => {
    if ("terminate" in embeddings && typeof embeddings.terminate === "function") {
      void (embeddings as { terminate: () => Promise<void> }).terminate();
    }
    if (embeddedRelease) {
      embeddedRelease();
    }
  };

  return {
    app,
    schemaBuilder,
    embeddedRelease,
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

  registerAllTools(server, { app: ctx.app, schemaBuilder: ctx.schemaBuilder });
  registerAllResources(server, ctx.app);
  registerAllPrompts(server, promptsConfig);

  return server;
}
