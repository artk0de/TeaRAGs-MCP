/**
 * Shared output schemas for MCP search tools.
 *
 * When outputSchema is provided to registerTool(), the SDK expects handlers
 * to return { structuredContent } matching this shape. We also keep { content }
 * for backwards compatibility with clients that don't support structured output.
 */

import { z } from "zod";

/** Mirrors RankingOverlay (contracts/types/reranker.ts). */
const RankingOverlaySchema = z.object({
  preset: z.string().optional().describe("Rerank preset used"),
  file: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("File-level signals keyed by bare field name: {value,label} when labelled, else the raw value"),
  chunk: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Chunk-level signals keyed by bare field name: {value,label} when labelled, else the raw value"),
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
  value: z.number().describe("0-1: score magnitude vs this collection's own similarity scale + path clustering"),
  label: z.string().describe("high | medium | low"),
});

/** Shared output schema for semantic_search, hybrid_search, rank_chunks, find_similar */
export const SearchResultOutputSchema = {
  results: z.array(SearchResultItemSchema).describe("Search results with explained metadata"),
  level: z.enum(["chunk", "file"]).optional().describe("Effective signal level used for scoring"),
  confidence: SearchConfidenceSchema.optional().describe(
    "Match quality, collection-relative. low = query likely has no match in project. " +
      "Advisory — never filters results. semantic_search / find_similar only; " +
      "absent on hybrid_search, rank_chunks, find_symbol, and on indexes with no measured scale (reindex fills it).",
  ),
  driftWarning: z.string().nullable().optional().describe("Warning if index may be stale"),
  fieldsWarning: z
    .string()
    .optional()
    .describe(
      "A path you passed in `fields` matched NO result, so its payloads came back without it. " +
        "Names the path and, where the returned payloads carry the same leaf elsewhere, the paths " +
        "that would have matched (e.g. git.commitCount → git.file.commitCount). " +
        "Also legitimate when the index simply lacks that enrichment.",
    ),
  presetFilterNotice: z
    .object({
      preset: z.string().describe("Rerank preset whose DEFAULT filter applied"),
      by: z
        .string()
        .describe(
          "Filter-preset name(s) and the payload keys they constrain, e.g. 'coreLogic (chunkType, isTest, codegraph.symbols.file.skippedAs)'",
        ),
      clearWith: z.string().describe("Search param that clears the default — always 'filter: {}'"),
      excluded: z.number().optional().describe("Candidates the default removed, when the count was free"),
    })
    .optional()
    .describe(
      "A rerank preset's DEFAULT filter narrowed this result set and you did not write it. " +
        "Most presets default to production (no tests / docs / block chunks), so a thin or empty " +
        "answer may be the default, not the corpus. Re-run with the named clearWith param to see " +
        "the excluded population. Absent whenever you passed your own 'filter'.",
    ),
  codegraphWarning: z
    .string()
    .optional()
    .describe(
      "Optional codegraph lookup skipped — codegraph unreachable from this server (stale daemon build, " +
        "build skew, daemon down, lock held). Names error code + remedy; results may miss collapsed symbols. " +
        "Surface to user.",
    ),
};
