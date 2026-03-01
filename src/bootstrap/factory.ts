// src/bootstrap/factory.ts
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { EmbeddingProvider } from "../core/adapters/embeddings/base.js";
import { EmbeddingProviderFactory } from "../core/adapters/embeddings/factory.js";
import { QdrantManager } from "../core/adapters/qdrant/client.js";
import { IngestFacade } from "../core/api/ingest-facade.js";
import { SchemaBuilder } from "../core/api/schema-builder.js";
import { SearchFacade } from "../core/api/search-facade.js";
import { structuralSignals } from "../core/search/derived-signals/index.js";
import { RELEVANCE_PRESETS, resolvePresets } from "../core/search/presets/index.js";
import { Reranker } from "../core/search/reranker.js";
import { gitDerivedSignals } from "../core/trajectory/git/derived-signals/index.js";
import { GIT_PRESETS } from "../core/trajectory/git/presets/index.js";
import { loadPromptsConfig, type PromptsConfig } from "../mcp/prompts/index.js";
import { registerAllPrompts } from "../mcp/prompts/register.js";
import { registerAllResources } from "../mcp/resources/index.js";
import { registerAllTools } from "../mcp/tools/index.js";
import type { AppConfig } from "./config.js";

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
  reranker: Reranker;
  schemaBuilder: SchemaBuilder;
}

export function createAppContext(config: AppConfig): AppContext {
  const qdrant = new QdrantManager(config.qdrantUrl, config.qdrantApiKey);
  const embeddings = EmbeddingProviderFactory.createFromEnv();
  const resolvedPresets = resolvePresets(RELEVANCE_PRESETS, GIT_PRESETS, []);
  const allDescriptors = [...gitDerivedSignals, ...structuralSignals];
  const reranker = new Reranker(allDescriptors, resolvedPresets);
  const schemaBuilder = new SchemaBuilder(reranker);
  const ingest = new IngestFacade(qdrant, embeddings, config.code);
  const search = new SearchFacade(qdrant, embeddings, config.code, reranker);
  return { qdrant, embeddings, ingest, search, reranker, schemaBuilder };
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
  });

  registerAllResources(server, ctx.qdrant);
  registerAllPrompts(server, promptsConfig);

  return server;
}
