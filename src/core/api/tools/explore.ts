/**
 * Search tools registration — thin wrappers delegating to App.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type {
  ExploreResponse,
  HybridSearchRequest,
  SearchResult,
  SemanticSearchRequest,
} from "../public/dto/explore.js";
import type { App, McpAutoUpdateTrigger, SchemaBuilderPort } from "../public/index.js";
import { tabulateRecords } from "./columns.js";
import { compactSearchResults, type SearchResultCompaction } from "./compact-results.js";
import {
  appendAutoUpdateHint,
  compactWorkingTreeMarker,
  formatDenseUnavailable,
  sanitizeRerank,
  type McpToolResult,
} from "./format.js";
import type { RegisterToolFn } from "./middleware/error-handler.js";
import { SearchResultOutputSchema } from "./output-schemas.js";
import { offsetContinuation, type ResponseRowsPolicy } from "./response-budget.js";
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
  /**
   * Ask Claude Code to load this tool's schema upfront instead of deferring it
   * behind ToolSearch (bd tea-rags-mcp-45kbu) — for the tools an agent calls
   * first, whose deferred schema costs it a whole turn.
   */
  alwaysLoad?: true;
  /** Rows the response budget guard trims (bd tea-rags-mcp-c01gm): always the `results` table. */
  responseRows: ResponseRowsPolicy;
  /**
   * A search tool: with `fields` absent its rows carry no point `id` / `score`
   * (bd tea-rags-mcp-q1g6s.16) — the row is addressed by its symbolId, which
   * find_similar(positiveIds) accepts too.
   */
  searchTool?: true;
}

/** `fields` absent, empty or all-blank — the default projection answers, as in `projectSearchResultPayloads`. */
function fieldsAbsent(fields: unknown): boolean {
  return !Array.isArray(fields) || fields.every((field) => typeof field !== "string" || field.trim() === "");
}

/** A default search row: payload, overlay and treeState, without the point id and score. */
function withoutIdAndScore(results: readonly SearchResult[]): object[] {
  return results.map(({ id: _id, score: _score, ...row }) => row);
}

const SEARCH_NARROWING = ["limit", "pathPattern", "fields", "metaOnly"] as const;

/** A ranked search: the omitted tail is the next `offset`. */
const PAGED_SEARCH_ROWS: ResponseRowsPolicy = {
  rows: ["results"],
  continuation: offsetContinuation(),
  narrowing: SEARCH_NARROWING,
};

/**
 * find_symbol: a `symbols` batch continues with the addresses whose rows were
 * cut (offset does not page a batch); every other mode pages by `offset`.
 */
const FIND_SYMBOL_ROWS: ResponseRowsPolicy = {
  rows: ["results"],
  continuation: (args, cut) => {
    if (!Array.isArray(args.symbols)) return offsetContinuation()(args, cut);
    // Rows are tabulated from `payload.request` (q1g6s.15: a bare `request` lookup never matched).
    const requestColumn = cut.columns?.indexOf("payload.request") ?? -1;
    if (requestColumn < 0) return undefined;
    const symbols = [...new Set(cut.omittedRows.map((row) => (row as unknown[])[requestColumn]))];
    const { offset: _offset, ...rest } = args;
    return { ...rest, symbols };
  },
  narrowing: SEARCH_NARROWING,
};

/** Claude Code's per-tool `_meta` key exempting a tool from deferred loading. */
const ALWAYS_LOAD_META_KEY = "anthropic/alwaysLoad";

/**
 * Format ExploreResponse as structuredContent for outputSchema-enabled tools.
 * Rows are compacted (imports counted, floats at 2 significant digits) before
 * they are tabulated — after the App ranked them, so order and scores hold.
 */
function formatStructuredResult(
  response: ExploreResponse,
  compaction: SearchResultCompaction,
  omitIdAndScore: boolean,
): McpToolResult {
  const rows = compactSearchResults(response.results, compaction);
  return {
    structuredContent: {
      results: tabulateRecords(omitIdAndScore ? withoutIdAndScore(rows) : rows),
      ...(response.level && { level: response.level }),
      ...(response.confidence && { confidence: response.confidence }),
      ...(response.driftWarning && { driftWarning: response.driftWarning }),
      ...(response.codegraphWarning && { codegraphWarning: response.codegraphWarning }),
      ...(response.presetFilterNotice && { presetFilterNotice: response.presetFilterNotice }),
      ...(response.fieldsWarning && { fieldsWarning: response.fieldsWarning }),
      ...(response.workingTree && { workingTree: compactWorkingTreeMarker(response.workingTree) }),
      ...(response.denseUnavailable && { denseUnavailable: response.denseUnavailable }),
      ...(response.next && { next: response.next }),
      ...(response.empty && { empty: response.empty }),
      ...(response.missing && { missing: response.missing }),
      ...(response.directory && { directory: response.directory }),
    },
    // A degraded ranking is said in text too: a reader of the text channel
    // would otherwise take a BM25-only answer for a hybrid one.
    content: response.denseUnavailable
      ? [{ type: "text", text: formatDenseUnavailable(response.denseUnavailable) }]
      : [],
  };
}

const SEARCH_TOOLS: readonly SearchToolDef[] = [
  {
    name: "semantic_search",
    title: "Semantic Search",
    description:
      "Analytical search. Return structured JSON; signals via rerank or fields. " +
      "Agentic workflows: analytics, reports, downstream processing.\n\n" +
      "Examples: tea-rags://schema/search-guide\n" +
      "Param docs: tea-rags://schema/overview",
    schemaKey: "SemanticSearchSchema",
    searchTool: true,
    responseRows: PAGED_SEARCH_ROWS,
    invoke: async (app, request) => app.semanticSearch(request as unknown as SemanticSearchRequest),
  },
  {
    name: "hybrid_search",
    title: "Hybrid Search",
    alwaysLoad: true,
    description:
      "Semantic + BM25 keyword search. Use when query has exact symbols, identifiers, " +
      "or markers (TODO, FIXME, specific names). Collection must be created enableHybrid=true.\n\n" +
      "Examples: tea-rags://schema/search-guide\n" +
      "Param docs: tea-rags://schema/overview",
    schemaKey: "HybridSearchSchema",
    searchTool: true,
    responseRows: PAGED_SEARCH_ROWS,
    invoke: async (app, request) => app.hybridSearch(request as unknown as HybridSearchRequest),
  },
  {
    name: "rank_chunks",
    title: "Rank Chunks",
    description:
      "Batch analytics: rank all chunks by rerank signals, no query. " +
      "metaOnly defaults true (unlike other search tools) — endpoint " +
      "for offline scoring (hotspot scan, ownership report, decomposition " +
      "candidates), NOT online search. Pair with pathPattern to scope domain.\n\n" +
      "Examples: tea-rags://schema/search-guide\n" +
      "Param docs: tea-rags://schema/overview",
    schemaKey: "RankChunksSchema",
    searchTool: true,
    responseRows: PAGED_SEARCH_ROWS,
    invoke: async (app, request) => app.rankChunks(request as unknown as Parameters<App["rankChunks"]>[0]),
  },
  {
    name: "find_similar",
    title: "Find Similar",
    description:
      "Find code similar to given snippet or previously found chunks. " +
      "Primary: paste code block into positiveCode to discover similar patterns, " +
      "duplicates, related implementations across indexed codebase. " +
      "Also accepts chunk IDs from previous results. " +
      "Supports negative examples to exclude unwanted patterns. " +
      "Anti-pattern mode: pass ONLY negativeCode / negativeIds with " +
      'strategy="best_score" to find code maximally UNLIKE negatives — ' +
      "outlier / novelty / refactor-candidate detection.\n\n" +
      "Param docs: tea-rags://schema/overview",
    schemaKey: "FindSimilarSchema",
    searchTool: true,
    responseRows: { rows: ["results"], narrowing: SEARCH_NARROWING },
    invoke: async (app, request) => app.findSimilar(request),
  },
  {
    name: "find_symbol",
    title: "Find Symbol",
    alwaysLoad: true,
    description:
      "Find symbol by name or file outline by relativePath — direct lookup, no embedding. " +
      "symbol mode: function/method → merged full body; class/module → OUTLINE only " +
      "(member symbolIds, no bodies, tests excluded); doc:<hash> → full section content. " +
      "relativePath mode: small code file (≤150 lines, or outline ≥ file) → full text, kind:'file', lines 1..endLine; " +
      "else file-level outline (code symbols); doc → TOC with doc:<hash> ids; metaOnly → outline; " +
      "directory path → files + top-level symbols + subdirs (`directory`); unknown path → `empty.suggestions`. " +
      "symbols mode: 1-20 symbol ids and/or file paths one call (a path answers as relativePath mode), " +
      "rows keyed by `request`, misses in `missing` (unknown path → `suggestions`), lean payload unless fields/rerank. " +
      "Outline/TOC lines are addresses — read one member/section via find_symbol(symbol: '<id from line>'), " +
      "never Read the file or grep a saved dump. " +
      "Member lines may end in declared visibility, e.g. 'Class#helper (private)' (codegraph; " +
      "no suffix = unknown) — drop the suffix before drilling. " +
      "Uses Qdrant text match. Partial match supported: 'Reranker' → class outline. " +
      "symbolId convention: Class#method (instance), Class.method (static). " +
      'Single-call diagnostic: pass `rerank` preset (e.g. "hotspots") to ' +
      "attach rankingOverlay with churn/ownership/bugFixRate labels alongside " +
      "definition — no second semantic_search needed.\n\n" +
      "Param docs: tea-rags://schema/overview",
    schemaKey: "FindSymbolSchema",
    responseRows: FIND_SYMBOL_ROWS,
    invoke: async (app, request) => app.findSymbol(request),
  },
];

export function registerSearchTools(
  server: McpServer,
  deps: { app: App; schemaBuilder: SchemaBuilderPort; register: RegisterToolFn; autoUpdate?: McpAutoUpdateTrigger },
): void {
  const { app, register: registerToolSafe, autoUpdate } = deps;
  const searchSchemas = createSearchSchemas(deps.schemaBuilder);
  // Derived from the composition's registry, fixed for the server's life.
  const customWeightSignals = deps.schemaBuilder.customWeightSignals();

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
        ...(tool.alwaysLoad && { _meta: { [ALWAYS_LOAD_META_KEY]: true } }),
        responseRows: tool.responseRows,
      },
      async (request: unknown) => {
        // `includeImports` shapes the answer, not the search: the App never sees it.
        const { includeImports, rerank, ...search } = request as SearchRequest;
        const sanitized = { ...search, rerank: sanitizeRerank(rerank as RerankParam, customWeightSignals) };
        const result = formatStructuredResult(
          await tool.invoke(app, sanitized),
          { includeImports: includeImports === true },
          tool.searchTool === true && fieldsAbsent(search.fields),
        );
        const hint = autoUpdate?.hintFor(request as { collection?: string; project?: string; path?: string }) ?? null;
        return appendAutoUpdateHint(result, hint);
      },
    );
  }
}
