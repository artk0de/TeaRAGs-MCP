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
import {
  BATCH_FULL_TEXT_CHAR_BUDGET,
  CONTAINER_HEADER_CHAR_BUDGET,
  FULL_TEXT_MAX_LINES,
  type App,
  type McpAutoUpdateTrigger,
  type SchemaBuilderPort,
} from "../public/index.js";
import { tabulateRecords } from "./columns.js";
import { compactSearchResults, type SearchResultCompaction } from "./compact-results.js";
import {
  appendAutoUpdateHint,
  compactWorkingTreeMarkerForCall,
  formatDenseUnavailable,
  sanitizeRerank,
  type McpToolResult,
  type WorkingTreeCallAddress,
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
 * The `workingTree` marker is dropped when the call's `address` makes it say
 * nothing (`compactWorkingTreeMarkerForCall`). No drift, no `next` hint list:
 * a search answer carries neither (bd tea-rags-mcp-68jud, icujw).
 */
function formatStructuredResult(
  response: ExploreResponse,
  compaction: SearchResultCompaction,
  omitIdAndScore: boolean,
  address: WorkingTreeCallAddress,
): McpToolResult {
  const rows = compactSearchResults(response.results, compaction);
  const workingTree = response.workingTree && compactWorkingTreeMarkerForCall(response.workingTree, address);
  return {
    structuredContent: {
      results: tabulateRecords(omitIdAndScore ? withoutIdAndScore(rows) : rows),
      ...(response.level && { level: response.level }),
      ...(response.confidence && { confidence: response.confidence }),
      ...(response.codegraphWarning && { codegraphWarning: response.codegraphWarning }),
      ...(response.presetFilterNotice && { presetFilterNotice: response.presetFilterNotice }),
      ...(response.fieldsWarning && { fieldsWarning: response.fieldsWarning }),
      ...(workingTree && { workingTree }),
      ...(response.denseUnavailable && { denseUnavailable: response.denseUnavailable }),
      ...(response.empty && { empty: response.empty }),
      ...(response.missing && { missing: response.missing }),
      ...(response.batchNotice && { batchNotice: response.batchNotice }),
      ...(response.directory && { directory: response.directory }),
      ...(response.table && { table: response.table }),
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
      "Also accepts symbolIds from previous results. " +
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
      "Direct lookup by name or path, no embedding. " +
      "symbol: method → full body; class/module → member OUTLINE (method ids, no bodies) + header chunks " +
      `(consts, DSL; ≤${CONTAINER_HEADER_CHAR_BUDGET} chars/class inlined, else 'not inlined'); ` +
      "doc:<hash> → section; table:<name> → Rails table state folded from migrations; migration:<id> → that operation. " +
      `relativePath: file ≤${FULL_TEXT_MAX_LINES} lines → full text, else outline; doc → TOC; directory → files + subdirs. ` +
      `symbols: 1-20 ids / paths in one call (full text until ${BATCH_FULL_TEXT_CHAR_BUDGET} chars, then outline); misses → missing. ` +
      "Outline lines are addresses: drill via find_symbol(symbol: '<id>'), never Read the file. " +
      "Member lines end in visibility (if known), then line range, e.g. 'Class#helper (private) L40-58'; " +
      "a file outline's container spans its members; a pasted suffix is tolerated. " +
      "Lines N–M / a grep -n hit → the ids whose ranges cover them, one find_symbol(symbols:[…]); never Read offset/limit. " +
      "Partial names match: 'Reranker' → class outline; 'B::C' → 'A::B::C'. " +
      "rerank preset attaches churn/ownership/bugFixRate labels.\n\n" +
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
          search,
        );
        const hint = autoUpdate?.hintFor(request as { collection?: string; project?: string; path?: string }) ?? null;
        return appendAutoUpdateHint(result, hint);
      },
    );
  }
}
