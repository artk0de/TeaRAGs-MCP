/**
 * Consolidated Zod schemas for all MCP tools
 *
 * Note: Schemas are exported as plain objects (not wrapped in z.object()) because
 * McpServer.registerTool() expects schemas in this format. The SDK internally
 * converts these to JSON Schema for the MCP protocol. Each property is a Zod
 * field definition that gets composed into the final schema by the SDK.
 *
 * Search-related schemas (SemanticSearch, HybridSearch, SearchCode) are generated
 * dynamically via createSearchSchemas(SchemaBuilder) to avoid hardcoded imports
 * from domain/foundation layers. All other schemas remain static.
 */

import { z } from "zod";

import type { SchemaBuilder } from "../../core/api/index.js";

/** Coerce string→number for MCP params (agents sometimes send "5" instead of 5) */
const coerceNumber = () => z.preprocess((v) => (typeof v === "string" ? Number(v) : v), z.number());

/** Coerce string→boolean for MCP params (agents sometimes send "true" instead of true) */
const coerceBoolean = () => z.preprocess((v) => (typeof v === "string" ? v === "true" : v), z.boolean());

// ---------------------------------------------------------------------------
// Collection management schemas (static)
// ---------------------------------------------------------------------------

export const CreateCollectionSchema = {
  name: z.string().describe("Name of the collection"),
  distance: z
    .enum(["Cosine", "Euclid", "Dot"])
    .optional()
    .describe(
      "Distance metric (default: Cosine). " +
        "Cosine: recommended, works with all embedding providers. " +
        "Dot: equivalent to Cosine for normalized embeddings. " +
        "Euclid: absolute vector distance, rarely needed for text embeddings.",
    ),
  enableHybrid: coerceBoolean().optional().describe("Enable hybrid search with sparse vectors (default: false)"),
};

export const DeleteCollectionSchema = {
  name: z.string().describe("Name of the collection to delete"),
};

export const GetCollectionInfoSchema = {
  name: z.string().describe("Name of the collection"),
};

// ---------------------------------------------------------------------------
// Document operation schemas (static)
// ---------------------------------------------------------------------------

export const AddDocumentsSchema = {
  collection: z.string().describe("Name of the collection"),
  documents: z
    .array(
      z.object({
        id: z.union([z.string(), z.number()]).describe("Unique identifier for the document"),
        text: z.string().describe("Text content to embed and store"),
        metadata: z.record(z.any()).optional().describe("Optional metadata to store with the document"),
      }),
    )
    .describe("Array of documents to add"),
};

export const DeleteDocumentsSchema = {
  collection: z.string().describe("Name of the collection"),
  ids: z.array(z.union([z.string(), z.number()])).describe("Array of document IDs to delete"),
};

// ---------------------------------------------------------------------------
// Code indexing schemas (static)
// ---------------------------------------------------------------------------

export const IndexCodebaseSchema = {
  path: z.string().describe("Absolute or relative path to codebase root directory"),
  forceReindex: coerceBoolean().optional().describe("Force full re-index even if already indexed (default: false)"),
  extensions: z.array(z.string()).optional().describe("Custom file extensions to index (e.g., ['.proto', '.graphql'])"),
  ignorePatterns: z
    .array(z.string())
    .optional()
    .describe("Additional patterns to ignore (e.g., ['**/test/**', '**/*.test.ts'])"),
};

export const ReindexChangesSchema = {
  path: z.string().describe("Path to codebase"),
};

export const GetIndexStatusSchema = {
  path: z.string().describe("Path to codebase"),
};

export const ClearIndexSchema = {
  path: z.string().describe("Path to codebase"),
};

// ---------------------------------------------------------------------------
// Search schemas (dynamic — generated from SchemaBuilder via DIP)
// ---------------------------------------------------------------------------

/**
 * Shared fields for collection/path resolution used in semantic/hybrid search.
 */
function collectionPathFields() {
  return {
    collection: z.string().optional().describe("Collection name. Provide either 'collection' or 'path', not both."),
    path: z
      .string()
      .optional()
      .describe(
        "Path to indexed codebase (auto-resolves collection name). Provide either 'path' or 'collection', not both.",
      ),
  };
}

/**
 * Typed filter params shared across all search tools (semantic, hybrid, search_code, rank_chunks).
 * These map 1:1 to TypedFilterParams in contracts/types/app.ts.
 */
function typedFilterFields() {
  return {
    language: z.string().optional().describe("Filter by programming language"),
    fileExtension: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .describe("Filter by file extension(s). Single string (e.g. '.ts') or array (e.g. ['.ts', '.py'])"),
    chunkType: z.string().optional().describe("Filter by chunk type (function, class, interface, block)"),
    documentation: z
      .enum(["only", "exclude", "include"])
      .optional()
      .describe(
        "Documentation filter mode. 'only' = documentation chunks only, " +
          "'exclude' = no documentation chunks, 'include' = all chunks (default).",
      ),
    author: z
      .string()
      .optional()
      .describe("Filter by dominant author (the author with most lines in chunk). Example: 'John Doe'"),
    modifiedAfter: z
      .string()
      .optional()
      .describe("Filter code modified after this date. ISO format: '2024-01-01' or '2024-01-01T00:00:00Z'"),
    modifiedBefore: z.string().optional().describe("Filter code modified before this date. ISO format: '2024-12-31'"),
    minAgeDays: coerceNumber().optional().describe("Filter code older than N days (since last modification)."),
    maxAgeDays: coerceNumber().optional().describe("Filter code newer than N days (since last modification)."),
    minCommitCount: coerceNumber()
      .optional()
      .describe("Filter by minimum number of commits touching the chunk (churn indicator)."),
    taskId: z
      .string()
      .optional()
      .describe(
        "Filter by task/issue ID from commit messages. Supports JIRA (TD-1234), GitHub (#567), Azure DevOps (AB#890).",
      ),
  };
}

/**
 * Shared fields for query, limit, filter, pathPattern used in semantic/hybrid search.
 */
function searchCommonFields() {
  return {
    query: z.string().describe("Search query text"),
    limit: coerceNumber().optional().describe("Maximum number of results (default: 10)"),
    filter: z
      .record(z.any())
      .optional()
      .describe(
        "Qdrant filter object with must/should/must_not conditions. " +
          "See tea-rags://schema/filters for syntax and available fields.",
      ),
    pathPattern: z
      .string()
      .optional()
      .describe(
        "Glob pattern for filtering by file path (client-side via picomatch). " +
          "Examples: '**/workflow/**', 'src/**/*.ts', '{models,services}/**'.",
      ),
  };
}

/**
 * Create dynamic search schemas from SchemaBuilder.
 * Replaces hardcoded imports from trajectory/ and search/structural-signals.
 */
/** Shared level field for all structured search tools. */
function levelField() {
  return {
    level: z
      .enum(["chunk", "file"])
      .optional()
      .describe(
        "Analysis level. 'chunk' = rank individual code chunks (functions, classes, blocks) — " +
          "use for decomposition candidates, hotspot detection. " +
          "'file' = rank files as aggregated units — use for tech debt and ownership analysis. " +
          "Default: determined by preset signalLevel. Explicit value overrides preset.",
      ),
  };
}

export function createSearchSchemas(schemaBuilder: SchemaBuilder) {
  const semanticSearchRerankSchema = schemaBuilder.buildRerankSchema("semantic_search");
  const searchCodeRerankSchema = schemaBuilder.buildRerankSchema("search_code");

  const SemanticSearchSchema = {
    ...collectionPathFields(),
    ...searchCommonFields(),
    ...typedFilterFields(),
    ...levelField(),
    rerank: semanticSearchRerankSchema
      .optional()
      .describe("Reranking preset or {custom: weights}. See tea-rags://schema/presets for details."),
    metaOnly: coerceBoolean()
      .optional()
      .describe("Return only metadata (path, lines, git info) without content. Reduces response size. Default: false."),
  };

  const HybridSearchSchema = {
    ...collectionPathFields(),
    ...searchCommonFields(),
    ...typedFilterFields(),
    ...levelField(),
    rerank: semanticSearchRerankSchema
      .optional()
      .describe("Reranking preset or {custom: weights}. See tea-rags://schema/presets for details."),
    metaOnly: coerceBoolean()
      .optional()
      .describe("Return only metadata (path, lines, git info) without content. Reduces response size. Default: false."),
  };

  const SearchCodeSchema = {
    path: z.string().describe("Path to codebase (must be indexed first)"),
    query: z.string().describe("Natural language search query (e.g., 'authentication logic')"),
    limit: coerceNumber().optional().describe("Maximum number of results (default: 10, max: 100)"),
    pathPattern: z
      .string()
      .optional()
      .describe(
        "Glob pattern for filtering by file path (client-side via picomatch). " +
          "Examples: '**/workflow/**', 'src/**/*.ts', '{models,services}/**'.",
      ),
    ...typedFilterFields(),
    rerank: searchCodeRerankSchema
      .optional()
      .describe("Reranking preset or {custom: weights}. See tea-rags://schema/presets for details."),
  };

  const rankChunksRerankSchema = schemaBuilder.buildRerankSchema("rank_chunks");

  const RankChunksSchema = {
    ...collectionPathFields(),
    ...typedFilterFields(),
    rerank: rankChunksRerankSchema.describe(
      "Reranking preset or {custom: weights} (REQUIRED). " +
        "similarity weight is ignored (no vector search). See tea-rags://schema/presets for details.",
    ),
    ...levelField(),
    limit: coerceNumber().optional().describe("Maximum number of results (default: 10)"),
    filter: z
      .record(z.any())
      .optional()
      .describe(
        "Qdrant filter object with must/should/must_not conditions. " +
          "See tea-rags://schema/filters for syntax and available fields.",
      ),
    pathPattern: z
      .string()
      .optional()
      .describe(
        "Glob pattern for filtering by file path (client-side via picomatch). " +
          "Examples: 'src/core/ingest/**', '**/*.ts'",
      ),
    offset: z.coerce
      .number()
      .int()
      .min(0)
      .optional()
      .default(0)
      .describe("Skip first N results (for pagination). Default: 0."),
    metaOnly: coerceBoolean()
      .optional()
      .default(true)
      .describe(
        "Return only metadata (path, lines, git info) without content. " +
          "Default: true (rank_chunks is analytics-oriented; use false to include code content).",
      ),
  };

  const findSimilarRerankSchema = schemaBuilder.buildRerankSchema("find_similar");

  const FindSimilarSchema = {
    ...collectionPathFields(),
    ...levelField(),
    positiveIds: z.array(z.string()).optional().describe("Chunk IDs from previous search results to find similar code"),
    positiveCode: z.array(z.string()).optional().describe("Raw code blocks to find similar code (embedded on-the-fly)"),
    negativeIds: z.array(z.string()).optional().describe("Chunk IDs to push results away from"),
    negativeCode: z.array(z.string()).optional().describe("Raw code blocks to push results away from"),
    strategy: z
      .enum(["best_score", "average_vector", "sum_scores"])
      .optional()
      .describe(
        "Recommend strategy. best_score (default): scores each candidate against every example, " +
          "supports negative-only. average_vector: averages all positive vectors, fastest. " +
          "sum_scores: sums scores across examples, middle ground.",
      ),
    filter: z
      .record(z.any())
      .optional()
      .describe(
        "Qdrant filter object with must/should/must_not conditions. " +
          "See tea-rags://schema/filters for syntax and available fields.",
      ),
    pathPattern: z.string().optional().describe("Glob pattern for filtering by file path (e.g. 'src/**/*.ts')"),
    fileExtensions: z.array(z.string()).optional().describe("Filter by file extensions (e.g. ['.ts', '.js'])"),
    rerank: findSimilarRerankSchema
      .optional()
      .describe("Reranking preset or {custom: weights}. See tea-rags://schema/presets for details."),
    limit: coerceNumber().optional().describe("Maximum number of results (default: 10)"),
    offset: coerceNumber().optional().describe("Offset for pagination (default: 0)"),
    metaOnly: coerceBoolean().optional().describe("Return only metadata without content (default: false)"),
  };

  return { SemanticSearchSchema, HybridSearchSchema, SearchCodeSchema, RankChunksSchema, FindSimilarSchema };
}

/** Return type of createSearchSchemas for typing in tool registrations. */
export type SearchSchemas = ReturnType<typeof createSearchSchemas>;
