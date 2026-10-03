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

/**
 * The chunk payload. Its keys depend on the index's enrichments, on `metaOnly`
 * and on `fields`, and find_symbol adds synthetic ones — so no key is declared
 * and every key passes through.
 */
const SearchResultPayloadSchema = z
  .object({})
  .passthrough()
  .describe(
    "Chunk payload: relativePath, startLine, endLine, language, chunkType, symbolId, name, content " +
      "(omitted when metaOnly=true), trajectory signals under git.{file,chunk}.* / codegraph.*, " +
      "plus find_symbol's chunkCount / mergedChunkIds. Raw values only — labels live on rankingOverlay.",
  );

/** Mirrors SearchResult (api/public/dto/explore.ts) — the only item shape search tools return. */
const SearchResultItemSchema = z.object({
  id: z.union([z.string(), z.number()]).describe("Chunk ID"),
  score: z.number().describe("Relevance score"),
  payload: SearchResultPayloadSchema.optional(),
  rankingOverlay: RankingOverlaySchema.optional().describe("Explains scoring signals"),
  treeState: z
    .enum(["modified", "deleted"])
    .optional()
    .describe("Index row of a file your working tree changed or deleted; content may be stale"),
});

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
  workingTree: z
    .object({
      tree: z.string(),
      indexedCommit: z.string().nullable(),
      treeCommit: z.string().nullable(),
      indexedDirty: z.boolean(),
      changedFiles: z.number(),
      deletedFiles: z.number(),
      floors: z.array(z.enum(["chunks", "sparse", "dense", "codegraph"])),
      degraded: z.object({ reason: z.string(), remedy: z.string() }).optional(),
      indexOnlyFiles: z.number().optional(),
      unparsed: z.array(z.string()).optional(),
      treeGraphUnavailable: z.string().optional(),
      denseUnavailable: z.object({ reason: z.string() }).optional(),
    })
    .optional()
    .describe(
      "Tree read vs index commit. changedFiles 0 = measured clean; floors = rows reflect tree " +
        "(dense = tree rows ranked by own vectors; codegraph = graph-tool answer, or a returned changed-file row, from the tree's graph); " +
        "degraded = run remedy; indexOnlyFiles = changed non-code files whose rows are the index's (treeState); " +
        "unparsed = changed files the tree's rows lack; " +
        "treeGraphUnavailable = why graph signals are the index's; " +
        "denseUnavailable = why some tree rows ranked without vectors (absent from dense ranking).",
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
