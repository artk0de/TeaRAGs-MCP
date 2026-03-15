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
  distance: z.enum(["Cosine", "Euclid", "Dot"]).optional().describe("Distance metric (default: Cosine)"),
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
    collection: z.string().optional().describe("Name of the collection to search. Required if 'path' not provided."),
    path: z
      .string()
      .optional()
      .describe(
        "Path to indexed codebase (alternative to 'collection'). " +
          "Collection name is auto-resolved from path. Required if 'collection' not provided.",
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
    fileExtension: z.string().optional().describe("Filter by file extension (e.g. '.ts')"),
    chunkType: z.string().optional().describe("Filter by chunk type (function, class, interface, block)"),
    isDocumentation: coerceBoolean().optional().describe("Include only documentation chunks"),
    excludeDocumentation: coerceBoolean().optional().describe("Exclude documentation chunks from results"),
    author: z
      .string()
      .optional()
      .describe(
        "Filter by dominant author (the author with most lines in chunk). " +
          "Use for: code review, ownership questions, team onboarding, finding expert for code area. " +
          "Example: 'John Doe'",
      ),
    modifiedAfter: z
      .string()
      .optional()
      .describe(
        "Filter code modified after this date. Use for: sprint review, release analysis, incident debugging. " +
          "ISO format: '2024-01-01' or '2024-01-01T00:00:00Z'",
      ),
    modifiedBefore: z
      .string()
      .optional()
      .describe(
        "Filter code modified before this date. Use for: finding old code, historical debugging, compliance audits. " +
          "ISO format: '2024-12-31'",
      ),
    minAgeDays: coerceNumber()
      .optional()
      .describe(
        "Filter code older than N days (since last modification). " +
          "Use for: finding legacy/stale code, tech debt assessment, documentation needs, refactoring candidates.",
      ),
    maxAgeDays: coerceNumber()
      .optional()
      .describe(
        "Filter code newer than N days (since last modification). " +
          "Use for: recent changes review, sprint work, incident response, release notes.",
      ),
    minCommitCount: coerceNumber()
      .optional()
      .describe(
        "Filter by minimum number of commits touching the chunk (churn indicator). " +
          "High churn = problematic areas, bugs, complex requirements. " +
          "Use for: risk assessment, code quality issues, refactoring priorities.",
      ),
    taskId: z
      .string()
      .optional()
      .describe(
        "Filter by task/issue ID from commit messages. Supports JIRA (TD-1234), GitHub (#567), Azure DevOps (AB#890). " +
          "Use for: requirements tracing, impact analysis, audit, compliance, 'what code was written for this ticket?'",
      ),
  };
}

/**
 * Shared fields for query, limit, filter, pathPattern used in semantic/hybrid search.
 */
function searchCommonFields() {
  return {
    query: z.string().describe("Search query text"),
    limit: coerceNumber().optional().describe("Maximum number of results (default: 5)"),
    filter: z
      .record(z.any())
      .optional()
      .describe(
        "Qdrant filter object with must/should/must_not conditions. " +
          "Available fields for code chunks (index_codebase): " +
          "relativePath (string), fileExtension (string), language (string), " +
          "startLine (number), endLine (number), chunkIndex (number), " +
          "isDocumentation (boolean), name (string), chunkType (string: function|class|interface|block), " +
          "parentName (string), parentType (string), " +
          "git.dominantAuthor (string), git.authors (string[]), " +
          "git.lastModifiedAt (unix timestamp), git.firstCreatedAt (unix timestamp), " +
          "git.commitCount (number), git.ageDays (number), git.taskIds (string[]), " +
          "imports (string[] - file-level imports for structural signal). " +
          "For generic documents (add_documents): user-defined metadata fields.",
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
        "Analysis level. 'chunk' (default): alpha-blended scoring, all chunks returned. " +
          "'file': pure file signals (alpha=0), one best chunk per file. " +
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
      .describe("Reranking preset or {custom: weights}. See preset descriptions for details."),
    metaOnly: coerceBoolean()
      .optional()
      .describe(
        "For code analytics: return only metadata (path, lines, git info) without content. " +
          "Use for: file discovery, codebase structure analysis, ownership reports, churn analysis. " +
          "Significantly reduces response size. Default: false.",
      ),
  };

  const HybridSearchSchema = {
    ...collectionPathFields(),
    ...searchCommonFields(),
    ...typedFilterFields(),
    ...levelField(),
    rerank: semanticSearchRerankSchema
      .optional()
      .describe("Reranking preset or {custom: weights}. See preset descriptions for details."),
    metaOnly: coerceBoolean()
      .optional()
      .describe(
        "For code analytics: return only metadata (path, lines, git info) without content. " +
          "Use for: file discovery, codebase structure analysis, ownership reports, churn analysis. " +
          "Significantly reduces response size. Default: false.",
      ),
  };

  const SearchCodeSchema = {
    path: z.string().describe("Path to codebase (must be indexed first)"),
    query: z.string().describe("Natural language search query (e.g., 'authentication logic')"),
    limit: coerceNumber().optional().describe("Maximum number of results (default: 5, max: 100)"),
    pathPattern: z
      .string()
      .optional()
      .describe(
        "Glob pattern for filtering by file path (client-side via picomatch). " +
          "Examples: '**/workflow/**', 'src/**/*.ts', '{models,services}/**'.",
      ),
    ...typedFilterFields(),
    fileTypes: z.array(z.string()).optional().describe("Filter by file extensions (e.g., ['.ts', '.py'])"),
    documentationOnly: coerceBoolean()
      .optional()
      .describe(
        "Search only in documentation files (markdown, READMEs, etc.). " +
          "Default: false (search in all files). Set to true to find information in docs only.",
      ),
    rerank: searchCodeRerankSchema
      .optional()
      .describe("Reranking preset or {custom: weights}. See preset descriptions for details."),
  };

  const rankChunksRerankSchema = schemaBuilder.buildRerankSchema("rank_chunks");

  const RankChunksSchema = {
    ...collectionPathFields(),
    ...typedFilterFields(),
    rerank: rankChunksRerankSchema.describe(
      "Reranking preset or {custom: weights} (REQUIRED). " +
        "similarity weight is ignored (no vector search). See preset descriptions for details.",
    ),
    ...levelField(),
    limit: coerceNumber().optional().describe("Maximum number of results (default: 10)"),
    filter: z
      .record(z.any())
      .optional()
      .describe(
        "Qdrant filter object with must/should/must_not conditions. " +
          "Available fields: relativePath, fileExtension, language, chunkType, " +
          "git.commitCount, git.ageDays, etc.",
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
      .describe("Return only metadata (path, lines, git info) without content. Default: true."),
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
    filter: z.record(z.any()).optional().describe("Qdrant filter object with must/should/must_not conditions"),
    pathPattern: z.string().optional().describe("Glob pattern for filtering by file path (e.g. 'src/**/*.ts')"),
    fileExtensions: z.array(z.string()).optional().describe("Filter by file extensions (e.g. ['.ts', '.js'])"),
    rerank: findSimilarRerankSchema
      .optional()
      .describe("Reranking preset or {custom: weights}. See preset descriptions for details."),
    limit: coerceNumber().optional().describe("Maximum number of results (default: 10)"),
    offset: coerceNumber().optional().describe("Offset for pagination (default: 0)"),
    metaOnly: coerceBoolean().optional().describe("Return only metadata without content (default: false)"),
  };

  return { SemanticSearchSchema, HybridSearchSchema, SearchCodeSchema, RankChunksSchema, FindSimilarSchema };
}

/** Return type of createSearchSchemas for typing in tool registrations. */
export type SearchSchemas = ReturnType<typeof createSearchSchemas>;
