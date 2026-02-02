/**
 * Consolidated Zod schemas for all MCP tools
 *
 * Note: Schemas are exported as plain objects (not wrapped in z.object()) because
 * McpServer.registerTool() expects schemas in this format. The SDK internally
 * converts these to JSON Schema for the MCP protocol. Each property is a Zod
 * field definition that gets composed into the final schema by the SDK.
 */

import { z } from "zod";

// Collection management schemas
export const CreateCollectionSchema = {
  name: z.string().describe("Name of the collection"),
  distance: z
    .enum(["Cosine", "Euclid", "Dot"])
    .optional()
    .describe("Distance metric (default: Cosine)"),
  enableHybrid: z
    .boolean()
    .optional()
    .describe("Enable hybrid search with sparse vectors (default: false)"),
};

export const DeleteCollectionSchema = {
  name: z.string().describe("Name of the collection to delete"),
};

export const GetCollectionInfoSchema = {
  name: z.string().describe("Name of the collection"),
};

// Document operation schemas
export const AddDocumentsSchema = {
  collection: z.string().describe("Name of the collection"),
  documents: z
    .array(
      z.object({
        id: z
          .union([z.string(), z.number()])
          .describe("Unique identifier for the document"),
        text: z.string().describe("Text content to embed and store"),
        metadata: z
          .record(z.any())
          .optional()
          .describe("Optional metadata to store with the document"),
      }),
    )
    .describe("Array of documents to add"),
};

export const DeleteDocumentsSchema = {
  collection: z.string().describe("Name of the collection"),
  ids: z
    .array(z.union([z.string(), z.number()]))
    .describe("Array of document IDs to delete"),
};

// Search schemas
export const SemanticSearchSchema = {
  collection: z.string().describe("Name of the collection to search"),
  query: z.string().describe("Search query text"),
  limit: z
    .number()
    .optional()
    .describe("Maximum number of results (default: 5)"),
  filter: z.record(z.any()).optional().describe("Optional metadata filter"),
  pathPattern: z
    .string()
    .optional()
    .describe(
      "Glob pattern for filtering by file path (client-side via picomatch). " +
        "Examples: '**/workflow/**', 'src/**/*.ts', '{models,services}/**'.",
    ),
};

export const HybridSearchSchema = {
  collection: z.string().describe("Name of the collection to search"),
  query: z.string().describe("Search query text"),
  limit: z
    .number()
    .optional()
    .describe("Maximum number of results (default: 5)"),
  filter: z.record(z.any()).optional().describe("Optional metadata filter"),
  pathPattern: z
    .string()
    .optional()
    .describe(
      "Glob pattern for filtering by file path (client-side via picomatch). " +
        "Examples: '**/workflow/**', 'src/**/*.ts', '{models,services}/**'.",
    ),
};

// Code indexing schemas
export const IndexCodebaseSchema = {
  path: z
    .string()
    .describe("Absolute or relative path to codebase root directory"),
  forceReindex: z
    .boolean()
    .optional()
    .describe("Force full re-index even if already indexed (default: false)"),
  extensions: z
    .array(z.string())
    .optional()
    .describe("Custom file extensions to index (e.g., ['.proto', '.graphql'])"),
  ignorePatterns: z
    .array(z.string())
    .optional()
    .describe(
      "Additional patterns to ignore (e.g., ['**/test/**', '**/*.test.ts'])",
    ),
};

export const SearchCodeSchema = {
  path: z.string().describe("Path to codebase (must be indexed first)"),
  query: z
    .string()
    .describe("Natural language search query (e.g., 'authentication logic')"),
  limit: z
    .number()
    .optional()
    .describe("Maximum number of results (default: 5, max: 100)"),
  fileTypes: z
    .array(z.string())
    .optional()
    .describe("Filter by file extensions (e.g., ['.ts', '.py'])"),
  pathPattern: z
    .string()
    .optional()
    .describe(
      "Glob pattern for filtering by file path (client-side via picomatch). " +
        "Examples: '**/workflow/**', 'src/**/*.ts', '{models,services}/**'.",
    ),
  documentationOnly: z
    .boolean()
    .optional()
    .describe(
      "Search only in documentation files (markdown, READMEs, etc.). " +
        "Default: false (search in all files). Set to true to find information in docs only.",
    ),
  // Git metadata filters (requires CODE_ENABLE_GIT_METADATA=true during indexing)
  // Uses canonical algorithm: aggregated signals per chunk
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
  minAgeDays: z
    .number()
    .optional()
    .describe(
      "Filter code older than N days (since last modification). " +
        "Use for: finding legacy/stale code, tech debt assessment, documentation needs, refactoring candidates.",
    ),
  maxAgeDays: z
    .number()
    .optional()
    .describe(
      "Filter code newer than N days (since last modification). " +
        "Use for: recent changes review, sprint work, incident response, release notes.",
    ),
  minCommitCount: z
    .number()
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

export const ReindexChangesSchema = {
  path: z.string().describe("Path to codebase"),
};

export const GetIndexStatusSchema = {
  path: z.string().describe("Path to codebase"),
};

export const ClearIndexSchema = {
  path: z.string().describe("Path to codebase"),
};
