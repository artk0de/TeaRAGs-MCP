// src/bootstrap/factory.ts
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { EmbeddingProvider } from "../core/adapters/embeddings/base.js";
import { EmbeddingProviderFactory } from "../core/adapters/embeddings/factory.js";
import { QdrantManager } from "../core/adapters/qdrant/client.js";
import { createComposition, type CompositionResult } from "../core/api/composition.js";
import { IngestFacade } from "../core/api/ingest-facade.js";
import { SchemaBuilder } from "../core/api/schema-builder.js";
import { SearchFacade } from "../core/api/search-facade.js";
import { StatsCache } from "../core/api/stats-cache.js";
import { loadPromptsConfig, type PromptsConfig } from "../mcp/prompts/index.js";
import { registerAllPrompts } from "../mcp/prompts/register.js";
import { registerAllResources } from "../mcp/resources/index.js";
import { registerAllTools } from "../mcp/tools/index.js";
import { getZodConfig, type AppConfig } from "./config.js";

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
}

export function createAppContext(config: AppConfig): AppContext {
  const qdrant = new QdrantManager(config.qdrantUrl, config.qdrantApiKey);
  const zodConfig = getZodConfig();
  const embeddings = EmbeddingProviderFactory.create(zodConfig.embedding);
  const { registry, reranker, allPayloadSignalDescriptors } = createComposition();
  const essentialTrajectoryFields = registry.getEssentialPayloadKeys();
  const schemaBuilder = new SchemaBuilder(reranker);
  const snapshotsDir = join(homedir(), ".tea-rags-mcp", "snapshots");
  const statsCache = new StatsCache(snapshotsDir);
  const deleteConfig = {
    batchSize: zodConfig.qdrantTune.deleteBatchSize,
    concurrency: zodConfig.qdrantTune.deleteConcurrency,
  };
  const ingest = new IngestFacade(
    qdrant,
    embeddings,
    config.code,
    statsCache,
    allPayloadSignalDescriptors,
    reranker,
    deleteConfig,
  );
  const search = new SearchFacade(qdrant, embeddings, config.code, reranker, registry, statsCache);
  return { qdrant, embeddings, ingest, search, reranker, schemaBuilder, essentialTrajectoryFields };
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
  });

  registerAllResources(server, ctx.qdrant);
  registerAllPrompts(server, promptsConfig);

  return server;
}
