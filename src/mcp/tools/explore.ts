/**
 * Search tools registration — thin wrappers delegating to App.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { App } from "../../core/api/app.js";
import type { SchemaBuilder } from "../../core/api/schema-builder.js";
import { appendDriftWarning, formatMcpError, formatMcpResponse, sanitizeRerank } from "../format.js";
import { createSearchSchemas } from "./schemas.js";

export function registerSearchTools(server: McpServer, deps: { app: App; schemaBuilder: SchemaBuilder }): void {
  const { app } = deps;
  const searchSchemas = createSearchSchemas(deps.schemaBuilder);

  // semantic_search
  server.registerTool(
    "semantic_search",
    {
      title: "Semantic Search",
      description:
        "Search for documents using natural language queries. Returns the most semantically similar documents.",
      inputSchema: searchSchemas.SemanticSearchSchema,
    },
    async ({ rerank, ...rest }) => {
      try {
        const response = await app.semanticSearch({
          ...rest,
          rerank: sanitizeRerank(rerank),
        });
        return appendDriftWarning(formatMcpResponse(response.results), response.driftWarning);
      } catch (error) {
        return formatMcpError(error instanceof Error ? error.message : String(error));
      }
    },
  );

  // hybrid_search
  server.registerTool(
    "hybrid_search",
    {
      title: "Hybrid Search",
      description:
        "Perform hybrid search combining semantic vector search with keyword search using BM25. This provides better results by combining the strengths of both approaches. The collection must be created with enableHybrid set to true.",
      inputSchema: searchSchemas.HybridSearchSchema,
    },
    async ({ rerank, ...rest }) => {
      try {
        const response = await app.hybridSearch({
          ...rest,
          rerank: sanitizeRerank(rerank),
        });
        return appendDriftWarning(formatMcpResponse(response.results), response.driftWarning);
      } catch (error) {
        return formatMcpError(error instanceof Error ? error.message : String(error));
      }
    },
  );

  // rank_chunks
  server.registerTool(
    "rank_chunks",
    {
      title: "Rank Chunks",
      description:
        "Rank all chunks in a collection by rerank signals without vector search. " +
        "Use for: finding decomposition candidates, tech debt analysis, hotspot detection, " +
        "ownership reports — any analysis where you need top-N chunks by signal, not by query similarity.",
      inputSchema: searchSchemas.RankChunksSchema,
    },
    async ({ rerank, ...rest }) => {
      try {
        const response = await app.rankChunks({
          ...rest,
          rerank: sanitizeRerank(rerank) as string | { custom: Record<string, number> },
        });
        return appendDriftWarning(formatMcpResponse(response.results), response.driftWarning);
      } catch (error) {
        return formatMcpError(error instanceof Error ? error.message : String(error));
      }
    },
  );
}
