/**
 * Shared output schemas for MCP search tools.
 *
 * When outputSchema is provided to registerTool(), the SDK expects handlers
 * to return { structuredContent } matching this shape. We also keep { content }
 * for backwards compatibility with clients that don't support structured output.
 */

import { z } from "zod";

const RankingOverlaySchema = z.object({
  preset: z.string().optional().describe("Rerank preset used"),
  raw: z
    .object({
      file: z.record(z.string(), z.unknown()).optional().describe("Raw file-level signals"),
      chunk: z.record(z.string(), z.unknown()).optional().describe("Raw chunk-level signals"),
    })
    .optional()
    .describe("Raw signal values from payload"),
  derived: z.record(z.string(), z.number()).optional().describe("Normalized derived signals (0-1)"),
});

const GitMetadataSchema = z
  .object({
    dominantAuthor: z.string().optional(),
    authors: z.array(z.string()).optional(),
    commitCount: z.number().optional(),
    ageDays: z.number().optional(),
    lastModifiedAt: z.string().optional(),
    firstCreatedAt: z.string().optional(),
    taskIds: z.array(z.string()).optional(),
  })
  .passthrough();

const SearchResultItemSchema = z
  .object({
    id: z.union([z.string(), z.number()]).optional().describe("Chunk ID"),
    score: z.number().describe("Relevance score"),
    relativePath: z.string().optional().describe("File path relative to codebase root"),
    startLine: z.number().optional().describe("Start line in file"),
    endLine: z.number().optional().describe("End line in file"),
    language: z.string().optional().describe("Programming language"),
    chunkType: z.string().optional().describe("Chunk type: function, class, interface, block"),
    name: z.string().optional().describe("Symbol name (function/class name)"),
    content: z.string().optional().describe("Code content (omitted when metaOnly=true)"),
    git: GitMetadataSchema.optional().describe("Git metadata (when indexed with git enrichment)"),
    rankingOverlay: RankingOverlaySchema.optional().describe("Explains scoring signals"),
  })
  .passthrough();

/** Shared output schema for semantic_search, hybrid_search, rank_chunks, find_similar */
export const SearchResultOutputSchema = {
  results: z.array(SearchResultItemSchema).describe("Search results with explained metadata"),
  level: z.enum(["chunk", "file"]).optional().describe("Effective signal level used for scoring"),
  driftWarning: z.string().nullable().optional().describe("Warning if index may be stale"),
};
