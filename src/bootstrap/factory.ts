// src/bootstrap/factory.ts
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { EmbeddingProvider } from "../core/adapters/embeddings/base.js";
import { EmbeddingProviderFactory } from "../core/adapters/embeddings/factory.js";
import { QdrantManager } from "../core/adapters/qdrant/client.js";
import { createComposition, type CompositionResult } from "../core/api/composition.js";
import { IngestFacade } from "../core/api/ingest-facade.js";
import { SchemaBuilder } from "../core/api/schema-builder.js";
import { SchemaDriftMonitor } from "../core/api/schema-drift-monitor.js";
import { SearchFacade } from "../core/api/search-facade.js";
import { StatsCache } from "../core/api/stats-cache.js";
import { setDebug } from "../core/ingest/pipeline/infra/runtime.js";
import { buildPipelineConfig } from "../core/ingest/pipeline/types.js";
import { loadPromptsConfig, type PromptsConfig } from "../mcp/prompts/index.js";
import { registerAllPrompts } from "../mcp/prompts/register.js";
import { registerAllResources } from "../mcp/resources/index.js";
import { registerAllTools } from "../mcp/tools/index.js";
import { getZodConfig, snapshotsDir, type AppConfig } from "./config/index.js";
import { resolveQdrantUrl } from "../embedded/daemon.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf-8")) as {
  name: string;
  version: string;
};

export { pkg };

export interface AppContext {
  qdrant: QdrantManager;
  embeddings: EmbeddingProvider;
  ingest: IngestFacade;
  search: SearchFacade;
  reranker: CompositionResult["reranker"];
  schemaBuilder: SchemaBuilder;
  essentialTrajectoryFields: string[];
  schemaDriftMonitor: SchemaDriftMonitor;
  embeddedRelease?: () => void;
}

export async function createAppContext(config: AppConfig): Promise<AppContext> {
  const resolution = await resolveQdrantUrl(config.qdrantUrl);
  const qdrant = new QdrantManager(resolution.url, config.qdrantApiKey);
  const embeddedRelease = resolution.mode === "embedded" ? resolution.release : undefined;
  const zodConfig = getZodConfig();
  setDebug(zodConfig.core.debug);
  const embeddings = EmbeddingProviderFactory.create(zodConfig.embedding);

  // Eagerly init ONNX to get calibrated batch size before pipeline config
  if ("initialize" in embeddings && typeof embeddings.initialize === "function") {
    await (embeddings as { initialize: () => Promise<void> }).initialize();
  }

  // If user didn't explicitly set batch size, use GPU-calibrated recommendation
  if (!zodConfig.flags.userSetBatchSize && "recommendedBatchSize" in embeddings && typeof embeddings.recommendedBatchSize === "number") {
    zodConfig.embedding.tune.batchSize = embeddings.recommendedBatchSize;
  }

  const { registry, reranker, allPayloadSignalDescriptors } = createComposition();
  const essentialTrajectoryFields = registry.getEssentialPayloadKeys();
  const schemaBuilder = new SchemaBuilder(reranker);
  const statsCache = new StatsCache(snapshotsDir());
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
  );
  const search = new SearchFacade(qdrant, embeddings, config.searchCode, reranker, registry, statsCache);
  const currentPayloadKeys = allPayloadSignalDescriptors.map((d) => d.key);
  const schemaDriftMonitor = new SchemaDriftMonitor(statsCache, currentPayloadKeys);
  return { qdrant, embeddings, ingest, search, reranker, schemaBuilder, essentialTrajectoryFields, schemaDriftMonitor, embeddedRelease };
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
    qdrant: ctx.qdrant,
    embeddings: ctx.embeddings,
    ingest: ctx.ingest,
    search: ctx.search,
    reranker: ctx.reranker,
    schemaBuilder: ctx.schemaBuilder,
    essentialTrajectoryFields: ctx.essentialTrajectoryFields,
    schemaDriftMonitor: ctx.schemaDriftMonitor,
  });

  registerAllResources(server, ctx.qdrant);
  registerAllPrompts(server, promptsConfig);

  return server;
}
