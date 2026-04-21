/**
 * Search tools registration — thin wrappers delegating to App.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { App, SchemaBuilder } from "../../core/api/index.js";
import type {
  ExploreResponse,
  FindSimilarRequest,
  FindSymbolRequest,
  HybridSearchRequest,
  RankChunksRequest,
  SemanticSearchRequest,
} from "../../core/api/public/dto/explore.js";
import { sanitizeRerank, type McpToolResult } from "../format.js";
import type { RegisterToolFn } from "../middleware/error-handler.js";
import { SearchResultOutputSchema } from "./output-schemas.js";
import { createSearchSchemas } from "./schemas.js";

type RerankParam = string | { custom: Record<string, number | undefined> } | undefined;
type SearchSchemas = ReturnType<typeof createSearchSchemas>;
type SearchRequest = Record<string, unknown>;

interface SearchToolDef {
  name: string;
  title: string;
  description: string;
  schemaKey: keyof SearchSchemas;
  invoke: (app: App, request: SearchRequest) => Promise<ExploreResponse>;
}

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

const SEARCH_TOOLS: readonly SearchToolDef[] = [
  {
    name: "semantic_search",
    title: "Semantic Search",
    description:
      "Analytical search returning structured JSON with full metadata. " +
      "For agentic workflows: analytics, reports, downstream processing.\n\n" +
      "For examples see tea-rags://schema/search-guide\n" +
      "For parameter docs see tea-rags://schema/overview",
    schemaKey: "SemanticSearchSchema",
    invoke: async (app, { rerank, ...rest }) =>
      app.semanticSearch({
        ...rest,
        rerank: sanitizeRerank(rerank as RerankParam),
      } as SemanticSearchRequest),
  },
  {
    name: "hybrid_search",
    title: "Hybrid Search",
    description:
      "Semantic + BM25 keyword search. Use when query contains exact symbols, identifiers, " +
      "or markers (TODO, FIXME, specific names). Collection must be created with enableHybrid=true.\n\n" +
      "For examples see tea-rags://schema/search-guide\n" +
      "For parameter docs see tea-rags://schema/overview",
    schemaKey: "HybridSearchSchema",
    invoke: async (app, { rerank, ...rest }) =>
      app.hybridSearch({
        ...rest,
        rerank: sanitizeRerank(rerank as RerankParam),
      } as HybridSearchRequest),
  },
  {
    name: "rank_chunks",
    title: "Rank Chunks",
    description:
      "Rank all chunks by rerank signals without vector search. " +
      "Top-N by signal, not by query similarity.\n\n" +
      "For examples see tea-rags://schema/search-guide\n" +
      "For parameter docs see tea-rags://schema/overview",
    schemaKey: "RankChunksSchema",
    invoke: async (app, { rerank, ...rest }) =>
      app.rankChunks({
        ...rest,
        rerank: sanitizeRerank(rerank as RerankParam) as string | { custom: Record<string, number> },
      } as RankChunksRequest),
  },
  {
    name: "find_similar",
    title: "Find Similar",
    description:
      "Find code similar to a given code snippet or previously found chunks. " +
      "Primary use case: paste a code block into positiveCode to discover similar patterns, " +
      "duplicates, or related implementations across the indexed codebase. " +
      "Also accepts chunk IDs from previous search results. " +
      "Supports negative examples to exclude unwanted patterns.\n\n" +
      "For parameter docs see tea-rags://schema/overview",
    schemaKey: "FindSimilarSchema",
    invoke: async (app, { rerank, ...rest }) =>
      app.findSimilar({
        ...rest,
        rerank: sanitizeRerank(rerank as RerankParam),
      } as FindSimilarRequest),
  },
  {
    name: "find_symbol",
    title: "Find Symbol",
    description:
      "Find symbol by name or file outline by relativePath — direct lookup, no embedding. " +
      "symbol mode: merged definition for functions, outline + members for classes. " +
      "relativePath mode: file-level outline (code symbols or doc TOC). " +
      "Uses Qdrant text match. Partial match supported: " +
      "'Reranker' finds the class and all its methods. " +
      "symbolId convention: Class#method (instance), Class.method (static).",
    schemaKey: "FindSymbolSchema",
    invoke: async (app, { rerank, ...rest }) =>
      app.findSymbol({
        ...rest,
        rerank: sanitizeRerank(rerank as RerankParam),
      } as FindSymbolRequest),
  },
];

export function registerSearchTools(
  server: McpServer,
  deps: { app: App; schemaBuilder: SchemaBuilder; register: RegisterToolFn },
): void {
  const { app, register: registerToolSafe } = deps;
  const searchSchemas = createSearchSchemas(deps.schemaBuilder);

  for (const tool of SEARCH_TOOLS) {
    registerToolSafe(
      server,
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: searchSchemas[tool.schemaKey],
        outputSchema: SearchResultOutputSchema,
        annotations: { readOnlyHint: true },
      },
      async (request: unknown) => formatStructuredResult(await tool.invoke(app, request as SearchRequest)),
    );
  }
}
