/**
 * Search tools registration — thin wrappers delegating to App.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { App, SchemaBuilder } from "../../core/api/index.js";
import type { ExploreResponse } from "../../core/api/public/dto/explore.js";
import { formatMcpError, sanitizeRerank, type McpToolResult } from "../format.js";
import { SearchResultOutputSchema } from "./output-schemas.js";
import { createSearchSchemas } from "./schemas.js";

type RerankParam = string | { custom: Record<string, number | undefined> } | undefined;

/** Format ExploreResponse as structuredContent for outputSchema-enabled tools. */
function formatStructuredResult(response: ExploreResponse): McpToolResult {
  return {
    structuredContent: {
      results: response.results,
      ...(response.level && { level: response.level }),
      driftWarning: response.driftWarning,
    },
    content: [],
  };
}

export function registerSearchTools(server: McpServer, deps: { app: App; schemaBuilder: SchemaBuilder }): void {
  const { app } = deps;
  const searchSchemas = createSearchSchemas(deps.schemaBuilder);

  // semantic_search
  server.registerTool(
    "semantic_search",
    {
      title: "Semantic Search",
      description:
        "Search for documents using natural language queries. Returns the most semantically similar documents.\n\n" +
        "Returns structured JSON array of results with explained metadata.",
      inputSchema: searchSchemas.SemanticSearchSchema,
      outputSchema: SearchResultOutputSchema,
      annotations: { readOnlyHint: true },
    },
    async ({ rerank, ...rest }) => {
      try {
        const response = await app.semanticSearch({
          ...rest,
          rerank: sanitizeRerank(rerank as RerankParam),
        });
        return formatStructuredResult(response);
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
        "Perform hybrid search combining semantic vector search with keyword search using BM25. This provides better results by combining the strengths of both approaches. The collection must be created with enableHybrid=true (see create_collection).\n\n" +
        "Returns structured JSON array of results with explained metadata.",
      inputSchema: searchSchemas.HybridSearchSchema,
      outputSchema: SearchResultOutputSchema,
      annotations: { readOnlyHint: true },
    },
    async ({ rerank, ...rest }) => {
      try {
        const response = await app.hybridSearch({
          ...rest,
          rerank: sanitizeRerank(rerank as RerankParam),
        });
        return formatStructuredResult(response);
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
        "ownership reports — any analysis where you need top-N chunks by signal, not by query similarity.\n\n" +
        "Returns structured JSON array of results with explained metadata.",
      inputSchema: searchSchemas.RankChunksSchema,
      outputSchema: SearchResultOutputSchema,
      annotations: { readOnlyHint: true },
    },
    async ({ rerank, ...rest }) => {
      try {
        const response = await app.rankChunks({
          ...rest,
          rerank: sanitizeRerank(rerank as RerankParam) as string | { custom: Record<string, number> },
        });
        return formatStructuredResult(response);
      } catch (error) {
        return formatMcpError(error instanceof Error ? error.message : String(error));
      }
    },
  );

  // find_similar
  server.registerTool(
    "find_similar",
    {
      title: "Find Similar",
      description:
        "Find code similar to given chunks or code blocks. Uses Qdrant recommend API. " +
        "Provide chunk IDs from previous search results and/or raw code blocks as positive (find more like this) " +
        "or negative (find less like this) examples. At least one positive or negative input is required.",
      inputSchema: searchSchemas.FindSimilarSchema,
      outputSchema: SearchResultOutputSchema,
      annotations: { readOnlyHint: true },
    },
    async ({ rerank, ...rest }) => {
      try {
        const response = await app.findSimilar({
          ...rest,
          rerank: sanitizeRerank(rerank as RerankParam),
        });
        return formatStructuredResult(response);
      } catch (error) {
        return formatMcpError(error instanceof Error ? error.message : String(error));
      }
    },
  );
}
