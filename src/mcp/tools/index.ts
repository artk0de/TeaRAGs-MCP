/**
 * Tool registration orchestrator
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { EmbeddingProvider } from "../../core/adapters/embeddings/base.js";
import type { QdrantManager } from "../../core/adapters/qdrant/client.js";
import type { IngestFacade } from "../../core/api/ingest-facade.js";
import type { SchemaBuilder } from "../../core/api/schema-builder.js";
import type { SearchFacade } from "../../core/api/search-facade.js";
import type { Reranker } from "../../core/search/reranker.js";
import { registerCodeTools } from "./code.js";
import { registerCollectionTools } from "./collection.js";
import { registerDocumentTools } from "./document.js";
import { registerSearchTools } from "./search.js";

export interface ToolDependencies {
  qdrant: QdrantManager;
  embeddings: EmbeddingProvider;
  ingest: IngestFacade;
  search: SearchFacade;
  reranker: Reranker;
  schemaBuilder: SchemaBuilder;
  essentialTrajectoryFields: string[];
}

/**
 * Register all MCP tools on the server
 */
export function registerAllTools(server: McpServer, deps: ToolDependencies): void {
  registerCollectionTools(server, {
    qdrant: deps.qdrant,
    embeddings: deps.embeddings,
  });

  registerDocumentTools(server, {
    qdrant: deps.qdrant,
    embeddings: deps.embeddings,
  });

  registerSearchTools(server, {
    qdrant: deps.qdrant,
    embeddings: deps.embeddings,
    reranker: deps.reranker,
    schemaBuilder: deps.schemaBuilder,
    essentialTrajectoryFields: deps.essentialTrajectoryFields,
  });

  registerCodeTools(server, {
    ingest: deps.ingest,
    search: deps.search,
    schemaBuilder: deps.schemaBuilder,
  });
}

// Re-export schemas for external use
export * from "./schemas.js";
