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
    recentDominantAuthor: z.string().optional(),
    authors: z.array(z.string()).optional(),
    commitCount: z.number().optional(),
    ageDays: z.number().optional(),
    lastModifiedAt: z.string().optional(),
    firstCreatedAt: z.string().optional(),
    taskIds: z.array(z.string()).optional(),
    blameDominantAuthor: z.string().optional().describe("Live-line owner from git blame HEAD"),
    blameDominantAuthorPct: z.number().optional().describe("Percentage of live lines owned by blameDominantAuthor"),
    blameAuthors: z.array(z.string()).optional().describe("Distinct authors of live lines (top-N)"),
    blameContributorCount: z.number().optional().describe("Distinct authors of live lines"),
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

const SearchConfidenceSchema = z.object({
  value: z.number().describe("Shape score 0-1: leader peak + score spread + path clustering"),
  label: z.string().describe("high | medium | low"),
});

/** Shared output schema for semantic_search, hybrid_search, rank_chunks, find_similar */
export const SearchResultOutputSchema = {
  results: z.array(SearchResultItemSchema).describe("Search results with explained metadata"),
  level: z.enum(["chunk", "file"]).optional().describe("Effective signal level used for scoring"),
  confidence: SearchConfidenceSchema.optional().describe(
    "Match quality from result-set shape, NOT absolute score. low = query likely has no match in project. " +
      "Advisory — never filters results. Absent on rank_chunks / find_symbol.",
  ),
  driftWarning: z.string().nullable().optional().describe("Warning if index may be stale"),
};
