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
/** Mirrors ReferencedDefinition (domains/explore/referenced-definitions.ts). */
const ReferencedDefinitionSchema = z.object({
  symbolId: z.string(),
  startLine: z.number(),
  endLine: z.number(),
  text: z.string().optional(),
});

const SearchResultPayloadSchema = z
  .object({})
  .passthrough()
  .describe(
    "Chunk payload: relativePath, startLine, endLine, language, chunkType, symbolId, name, content " +
      "(omitted when metaOnly=true), trajectory signals under git.{file,chunk}.* / codegraph.*, " +
      "plus find_symbol's chunkCount / mergedChunkIds. Raw values only — labels live on rankingOverlay. " +
      "imports = count unless includeImports=true; floats at 2 significant digits.",
  );

/** Mirrors SearchResult (api/public/dto/explore.ts) — the only item shape search tools return. */
export const SearchResultItemSchema = z.object({
  id: z.union([z.string(), z.number()]).optional().describe("Chunk ID (search tools: only with fields)"),
  score: z.number().optional().describe("Relevance score (search tools: only with fields)"),
  payload: SearchResultPayloadSchema.optional(),
  rankingOverlay: RankingOverlaySchema.optional().describe("Explains scoring signals"),
  treeState: z
    .enum(["modified", "deleted"])
    .optional()
    .describe("Index row of a file your working tree changed or deleted; content may be stale"),
});

/**
 * find_symbol's payload: the shared one plus `referencedDefinitions`, the key
 * only find_symbol method rows carry (bd tea-rags-mcp-d0z7b.4) — declared on
 * find_symbol alone, so the other search tools' tools/list stays unchanged.
 */
const FindSymbolPayloadSchema = SearchResultPayloadSchema.extend({
  referencedDefinitions: z
    .array(ReferencedDefinitionSchema)
    .optional()
    .describe("Method row: lines defining class constants its body names; no text = over cap, read by symbolId"),
});

/** A find_symbol result item. */
export const FindSymbolResultItemSchema = SearchResultItemSchema.extend({
  payload: FindSymbolPayloadSchema.optional(),
});

/** Search results as ColumnTable (columns.ts); each row is one SearchResultItemSchema record. */
export const ColumnTableSchema = z
  .object({
    columns: z.array(z.string()),
    rows: z.array(z.array(z.unknown())),
  })
  .describe(
    "One row per result; cell i belongs to columns[i]. Dotted column = payload path " +
      "(payload.relativePath, rankingOverlay.chunk.bugFixRate.label). null = absent; a column null in every row is omitted. " +
      "Columns: [id, score], payload.* (raw values; content omitted when metaOnly), " +
      "rankingOverlay.{file,chunk}.* (labels), treeState (modified|deleted: index copy of a file your tree changed, may be stale).",
  );

const SearchConfidenceSchema = z.object({
  value: z.number().describe("0-1: score magnitude vs this collection's own similarity scale + path clustering"),
  label: z.string().describe("high | medium | low"),
});

/** Shared output schema for semantic_search, hybrid_search, rank_chunks, find_similar */
export const SearchResultOutputSchema = {
  banner: z.string().optional().describe("First key when present: next-step imperative — follow it."),
  results: z
    .union([ColumnTableSchema, z.array(SearchResultItemSchema)])
    .describe("Two or more results: the table. Zero or one: a plain list of result records."),
  level: z.enum(["chunk", "file"]).optional().describe("Effective signal level used for scoring"),
  confidence: SearchConfidenceSchema.optional().describe(
    "Match quality, collection-relative. low = query likely has no match in project. " +
      "Advisory — never filters results. semantic_search / find_similar only; " +
      "absent on hybrid_search, rank_chunks, find_symbol, and on indexes with no measured scale (reindex fills it).",
  ),
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
      changedFiles: z.number().optional(),
      deletedFiles: z.number().optional(),
      project: z.string().optional(),
      degraded: z.object({ reason: z.string(), remedy: z.string() }).optional(),
      indexOnlyFiles: z.number().optional(),
      pendingFiles: z.number().optional(),
      unparsed: z.array(z.string()).optional(),
      treeGraphUnavailable: z.string().optional(),
      denseUnavailable: z.object({ reason: z.string() }).optional(),
      gitUnavailable: z.object({ reason: z.string() }).optional(),
    })
    .optional()
    .describe(
      "Tree read vs index commit. project = registry alias of the answering index (pass it as project next call); " +
        "absent (call had project + path = tree) or tree + project only = every row current; changedFiles / deletedFiles appear only beside a field below (rows without treeState are current); " +
        "degraded = run remedy; indexOnlyFiles = changed non-code files whose rows are the index's (treeState); " +
        "pendingFiles = changed code files still warming, answered from the index this call (treeState); " +
        "unparsed = changed files the tree's rows lack; " +
        "treeGraphUnavailable = why graph signals are the index's; " +
        "denseUnavailable = why some tree rows ranked without vectors (absent from dense ranking); " +
        "gitUnavailable = how many changed-file rows still lack git signals (computing; re-call later).",
    ),
  denseUnavailable: z
    .object({ reason: z.string() })
    .optional()
    .describe(
      "hybrid_search only: embedding provider down, so results are ranked by BM25 alone (exact names still match; " +
        "no semantic ranking). reason = the provider's error.",
    ),
  codegraphWarning: z
    .string()
    .optional()
    .describe(
      "Optional codegraph lookup skipped — codegraph unreachable from this server (stale daemon build, " +
        "build skew, daemon down, lock held). Names error code + remedy; results may miss collapsed symbols. " +
        "Surface to user.",
    ),
  empty: z
    .object({ reason: z.string(), message: z.string(), suggestions: z.array(z.string()).optional() })
    .optional()
    .describe(
      "Empty results only — why + ≤5 alternatives. hybrid_search / semantic_search: pathPatternMatchesNothing " +
        "(suggestions = nearest existing prefix), filteredOut (what to drop, filter: {}), noMatch. find_symbol: " +
        "unknownSymbol (single symbol; suggestions = the real id: other #/. separator, #partN parent, same short name; " +
        "batch misses stay in missing[]), ambiguous (partial path, several ids = suggestions), " +
        "unknownPath (suggestions = nearest paths), noSymbols (no symbol chunks: default code read tool), " +
        "table:<name>: noTableOperations (no migration names it) / notBuilt (no migration corpus). Act on it; empty with reason ≠ grep needed.",
    ),
  missing: z
    .array(
      z.object({
        request: z.string(),
        message: z.string(),
        treeState: z.enum(["modified", "deleted"]).optional(),
        suggestions: z.array(z.string()).optional(),
      }),
    )
    .optional()
    .describe(
      "find_symbol symbols only: addresses nothing answered; ambiguous → qualify with Class# or pathPattern; unknown path → suggestions = nearest paths.",
    ),
  batchNotice: z.string().optional().describe("find_symbol symbols: a path outlined, not read, or a dir refused."),
  directory: z
    .object({
      kind: z.literal("directory"),
      dir: z.string(),
      subdirs: z.array(z.object({ dir: z.string(), fileCount: z.number() })),
      total: z.number(),
      truncated: z.boolean(),
    })
    .optional()
    .describe(
      "find_symbol directory path: results = its files (relativePath, language, symbols); subdirs one level down.",
    ),
  table: z
    .object({
      table: z.string(),
      columns: z.array(
        z.object({
          name: z.string(),
          type: z.string().optional(),
          origin: z.string(),
          renamedFrom: z.string().optional(),
        }),
      ),
      indexes: z.array(
        z.object({
          name: z.string().optional(),
          columns: z.array(z.string()),
          unique: z.boolean(),
          origin: z.string(),
          renamedFrom: z.string().optional(),
          where: z.string().optional(),
        }),
      ),
      foreignKeys: z.array(
        z.object({
          toTable: z.string(),
          column: z.string(),
          origin: z.string(),
          onDelete: z.string().optional(),
          onUpdate: z.string().optional(),
        }),
      ),
      dropped: z.object({ origin: z.string(), renamedTo: z.string().optional() }).optional(),
      unfolded: z.array(z.object({ symbolId: z.string(), operation: z.string(), reason: z.string() })),
      provenance: z.array(z.string()),
    })
    .optional()
    .describe(
      "find_symbol table:<name>: current state from change/up migrations in version order (down ignored). " +
        "origin/provenance = migration:<id>, drill via find_symbol. unfolded = ops not applied (raw SQL, unknown).",
    ),
  truncated: z
    .object({
      returned: z.number(),
      omitted: z.number(),
      next: z.object({ tool: z.string(), args: z.record(z.string(), z.unknown()), why: z.string() }).optional(),
      message: z.string().optional(),
    })
    .optional()
    .describe("Over the response budget: tail rows dropped whole. next = same call for the rest — run verbatim."),
};

/** find_symbol's output schema: the shared one with {@link FindSymbolResultItemSchema} records. */
export const FindSymbolOutputSchema = {
  ...SearchResultOutputSchema,
  results: z
    .union([ColumnTableSchema, z.array(FindSymbolResultItemSchema)])
    .describe("Two or more results: the table. Zero or one: a plain list of result records."),
};
