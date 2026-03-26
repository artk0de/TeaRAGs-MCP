/**
 * Search tools registration — thin wrappers delegating to App.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { App, SchemaBuilder } from "../../core/api/index.js";
import type { ExploreResponse } from "../../core/api/public/dto/explore.js";
import { sanitizeRerank, type McpToolResult } from "../format.js";
import type { RegisterToolFn } from "../middleware/error-handler.js";
import { SearchResultOutputSchema } from "./output-schemas.js";
import { createSearchSchemas } from "./schemas.js";

type RerankParam = string | { custom: Record<string, number | undefined> } | undefined;

/** Format ExploreResponse as structuredContent for outputSchema-enabled tools. */
function formatStructuredResult(response: ExploreResponse): McpToolResult {
  return {
    structuredContent: {
      results: response.results,
      ...(response.level && { level: response.level }),
      ...(response.driftWarning && { driftWarning: response.driftWarning }),
    },
    content: [],
  };
}

export function registerSearchTools(
  server: McpServer,
  deps: { app: App; schemaBuilder: SchemaBuilder; register: RegisterToolFn },
): void {
  const { app, register: registerToolSafe } = deps;
  const searchSchemas = createSearchSchemas(deps.schemaBuilder);

  // semantic_search
  registerToolSafe(
    server,
    "semantic_search",
    {
      title: "Semantic Search",
      description:
        "Analytical search returning structured JSON with full metadata. " +
        "For agentic workflows: analytics, reports, downstream processing.\n\n" +
        "For examples see tea-rags://schema/search-guide\n" +
        "For parameter docs see tea-rags://schema/overview",
      inputSchema: searchSchemas.SemanticSearchSchema,
      outputSchema: SearchResultOutputSchema,
      annotations: { readOnlyHint: true },
    },
    async ({ rerank, ...rest }) => {
      const response = await app.semanticSearch({
        ...rest,
        rerank: sanitizeRerank(rerank as RerankParam),
      });
      return formatStructuredResult(response);
    },
  );

  // hybrid_search
  registerToolSafe(
    server,
    "hybrid_search",
    {
      title: "Hybrid Search",
      description:
        "Semantic + BM25 keyword search. Use when query contains exact symbols, identifiers, " +
        "or markers (TODO, FIXME, specific names). Collection must be created with enableHybrid=true.\n\n" +
        "For examples see tea-rags://schema/search-guide\n" +
        "For parameter docs see tea-rags://schema/overview",
      inputSchema: searchSchemas.HybridSearchSchema,
      outputSchema: SearchResultOutputSchema,
      annotations: { readOnlyHint: true },
    },
    async ({ rerank, ...rest }) => {
      const response = await app.hybridSearch({
        ...rest,
        rerank: sanitizeRerank(rerank as RerankParam),
      });
      return formatStructuredResult(response);
    },
  );

  // rank_chunks
  registerToolSafe(
    server,
    "rank_chunks",
    {
      title: "Rank Chunks",
      description:
        "Rank all chunks by rerank signals without vector search. " +
        "Top-N by signal, not by query similarity.\n\n" +
        "For examples see tea-rags://schema/search-guide\n" +
        "For parameter docs see tea-rags://schema/overview",
      inputSchema: searchSchemas.RankChunksSchema,
      outputSchema: SearchResultOutputSchema,
      annotations: { readOnlyHint: true },
    },
    async ({ rerank, ...rest }) => {
      const response = await app.rankChunks({
        ...rest,
        rerank: sanitizeRerank(rerank as RerankParam) as string | { custom: Record<string, number> },
      });
      return formatStructuredResult(response);
    },
  );

  // find_similar
  registerToolSafe(
    server,
    "find_similar",
    {
      title: "Find Similar",
      description:
        "Find code similar to a given code snippet or previously found chunks. " +
        "Primary use case: paste a code block into positiveCode to discover similar patterns, " +
        "duplicates, or related implementations across the indexed codebase. " +
        "Also accepts chunk IDs from previous search results. " +
        "Supports negative examples to exclude unwanted patterns.\n\n" +
        "For parameter docs see tea-rags://schema/overview",
      inputSchema: searchSchemas.FindSimilarSchema,
      outputSchema: SearchResultOutputSchema,
      annotations: { readOnlyHint: true },
    },
    async ({ rerank, ...rest }) => {
      const response = await app.findSimilar({
        ...rest,
        rerank: sanitizeRerank(rerank as RerankParam),
      });
      return formatStructuredResult(response);
    },
  );

  // find_symbol
  registerToolSafe(
    server,
    "find_symbol",
    {
      title: "Find Symbol",
      description:
        "Find symbol by name — direct lookup, no embedding. " +
        "Returns merged definition for functions (chunks joined), outline + members for classes. " +
        "Uses Qdrant text match on symbolId field. Partial match supported: " +
        "'Reranker' finds the class and all its methods.",
      inputSchema: searchSchemas.FindSymbolSchema,
      outputSchema: SearchResultOutputSchema,
      annotations: { readOnlyHint: true },
    },
    async ({ rerank, ...rest }) => {
      const response = await app.findSymbol({
        ...rest,
        rerank: sanitizeRerank(rerank as RerankParam),
      });
      return formatStructuredResult(response);
    },
  );
}
