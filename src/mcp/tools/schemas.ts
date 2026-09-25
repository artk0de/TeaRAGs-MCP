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
 *
 * Param descriptions are INLINE HINTS (≤ 20 words): the one semantic an agent
 * would otherwise get wrong. Reference prose — per-filter level defaults, the
 * metaOnly contract, filter-default resolution — lives in
 * tea-rags://schema/overview (`buildOverview`), which every search tool links.
 * `tests/mcp/tools/param-applicability.test.ts` enforces the budget over the
 * real tools/list (bd tea-rags-mcp-ewg2s).
 */

import { z } from "zod";

import { PROJECT_NAME_RE, type SchemaBuilder } from "../../core/api/public/index.js";

/** Coerce string→number for MCP params (agents sometimes send "5" instead of 5) */
const coerceNumber = () => z.preprocess((v) => (typeof v === "string" ? Number(v) : v), z.number());

/** Coerce string→boolean for MCP params (agents sometimes send "true" instead of true) */
const coerceBoolean = () => z.preprocess((v) => (typeof v === "string" ? v === "true" : v), z.boolean());

/**
 * Optional project alias field. Mirrors the regex used by CollectionRegistry
 * and SchemaBuilder.collectionIdentifier(). Exposed on every project-aware
 * MCP tool as the RECOMMENDED way to address a codebase — see register_project
 * to create an alias.
 */
const projectField = () =>
  z
    .string()
    .regex(PROJECT_NAME_RE, `Project name must match ${PROJECT_NAME_RE.source}`)
    .optional()
    .describe(
      "[RECOMMENDED] Registered project alias; survives path moves. Resolution priority: collection > project > path.",
    );

/** `path` hint for the project-or-path tools (index status / metrics / clear). */
const PROJECT_OR_PATH_HINT = "Codebase path. Prefer 'project' when an alias is registered.";

// ---------------------------------------------------------------------------
// Collection management schemas (static)
// ---------------------------------------------------------------------------

export const CreateCollectionSchema = {
  name: z.string().describe("Name of the collection"),
  distance: z
    .enum(["Cosine", "Euclid", "Dot"])
    .optional()
    .describe("Distance metric, default Cosine. Dot ≡ Cosine on normalized embeddings; Euclid rarely fits text."),
  enableHybrid: coerceBoolean().optional().describe("Enable hybrid search with sparse vectors (default: false)"),
  schema: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "JSON Schema { type: object, properties } for metadata; add_documents validates per batch, fills defaults.",
    ),
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
        metadata: z.record(z.string(), z.any()).optional().describe("Optional metadata to store with the document"),
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
  path: z
    .string()
    .optional()
    .describe("Codebase root. Needed for first index; re-index a registered alias via 'project'."),
  project: projectField(),
  forceReindex: coerceBoolean()
    .optional()
    .describe("Full rebuild into a new collection. With any scope filter below: re-chunk only those files in place."),
  languages: z
    .array(z.string())
    .optional()
    .describe("Scoped force: re-chunk files of these languages. Needs forceReindex."),
  testFile: z
    .enum(["only", "exclude"])
    .optional()
    .describe("Scoped force: re-chunk only test files, or all but them. Needs forceReindex."),
  pathPattern: z
    .string()
    .optional()
    .describe("Scoped force: picomatch glob of files to re-chunk, leading ! negates. Needs forceReindex."),
  fileExtension: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe("Scoped force: extension(s) to re-chunk, '.rb' or ['.rb', '.rake']. Needs forceReindex."),
  files: z
    .array(z.string())
    .optional()
    .describe("Scoped force: exact project-relative files to re-chunk. Needs forceReindex."),
  extensions: z.array(z.string()).optional().describe("Custom file extensions to index (e.g., ['.proto', '.graphql'])"),
  ignorePatterns: z
    .array(z.string())
    .optional()
    .describe("Additional patterns to ignore (e.g., ['**/test/**', '**/*.test.ts'])"),
  seedFromWorktree: coerceBoolean()
    .optional()
    .describe(
      "First index only, default true: clone an indexed sibling worktree, embed only differing files. false = scratch.",
    ),
};

export const GetIndexStatusSchema = {
  path: z.string().optional().describe(PROJECT_OR_PATH_HINT),
  project: projectField(),
};

export const ClearIndexSchema = {
  path: z.string().optional().describe(PROJECT_OR_PATH_HINT),
  project: projectField(),
};

export const GetIndexMetricsSchema = {
  path: z.string().optional().describe(PROJECT_OR_PATH_HINT),
  project: projectField(),
};

// FindSymbolSchema is dynamic (needs rerank presets) — see createSearchSchemas()

// ---------------------------------------------------------------------------
// Search schemas (dynamic — generated from SchemaBuilder via DIP)
// ---------------------------------------------------------------------------

/**
 * Shared fields for collection/path/project resolution used by every
 * project-aware search tool. Mirrors the {@link CollectionIdentifier} DTO
 * mixin (resolution priority: collection > project > path).
 */
function collectionPathFields() {
  return {
    collection: z.string().optional().describe("Raw Qdrant collection name — lowest-level handle; prefer 'project'."),
    project: projectField(),
    path: z
      .string()
      .optional()
      .describe("Indexed codebase path; auto-resolves to its collection. Prefer 'project' when aliased."),
  };
}

/**
 * Typed filter param CATALOG shared across the typed-filter search tools
 * (semantic, hybrid, search_code, rank_chunks). Keys map 1:1 to
 * TypedFilterParams in api/public/dto/explore.ts; each key names the
 * `FilterDescriptor#param` of the trajectory that applies it.
 *
 * The catalog is the MCP-side shape (coercion + hint). Which entries a tool
 * EXPOSES is decided by the registry: {@link typedFilterFields} keeps only the
 * params a registered trajectory applies, so codegraph filters vanish when the
 * codegraph trajectory is off instead of being accepted and silently ignored
 * (bd tea-rags-mcp-86wsz).
 */
function typedFilterCatalog() {
  return {
    language: z.string().optional().describe("Filter by programming language"),
    fileExtension: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .describe("File extension(s): '.ts' or ['.ts', '.py']."),
    chunkType: z.string().optional().describe("Filter by chunk type (function, class, interface, block)"),
    documentation: z
      .enum(["only", "exclude", "include"])
      .optional()
      .describe(
        "Doc chunks: only | exclude | include. Omitted → preset default may exclude docs; only/include drops it.",
      ),
    testFile: z
      .enum(["only", "exclude", "include"])
      .optional()
      .describe(
        "Test files: only | exclude | include. Omitted → preset default may exclude tests; only/include drops it.",
      ),
    author: z
      .string()
      .optional()
      .describe(
        "Blame owner (most live lines, git blame HEAD), exact name. File default; level 'chunk' → chunk lines.",
      ),
    recentAuthor: z
      .string()
      .optional()
      .describe("Top committer to the FILE in git log window (not blame), exact name or email. 'What X worked on'."),
    contributor: z
      .string()
      .optional()
      .describe("Any committer to the FILE in git log window, exact name (no email); superset of recentAuthor."),
    modifiedAfter: z
      .string()
      .optional()
      .describe("File last commit on/after ISO date ('2024-01-01'). File-level at any level."),
    modifiedBefore: z
      .string()
      .optional()
      .describe("File last commit on/before ISO date ('2024-12-31'). File-level at any level."),
    minAgeDays: coerceNumber()
      .optional()
      .describe(
        "Last commit ≥ N days old, query time. Chunk default drops docs + no-commit chunks; level 'file' → file.",
      ),
    maxAgeDays: coerceNumber()
      .optional()
      .describe("Last commit ≤ N whole days old, query time (0 = within a day). Level-aware like minAgeDays."),
    minCommitCount: coerceNumber()
      .optional()
      .describe("Min commits touching the chunk (churn). Level-aware, chunk default."),
    taskId: z
      .string()
      .optional()
      .describe("Task ID from commit messages (TD-1234, #567, AB#890). File default; level 'chunk' → chunk commits."),
    symbolId: z
      .string()
      .optional()
      .describe("Partial symbolId text match: 'Class' hits all its methods, 'method' hits it in any class."),
    // Codegraph trajectory — names map to nested Qdrant paths in codegraphFilters.toCondition().
    minFanIn: coerceNumber()
      .optional()
      .describe("Min fan-in. File default = files importing this file; level 'chunk' = call sites."),
    minFanOut: coerceNumber()
      .optional()
      .describe("Min fan-out. File default = files this file imports; level 'chunk' = outgoing calls."),
    minPageRank: coerceNumber().optional().describe("Min chunk-level PageRank in [0,1] over the method call graph."),
    minInstability: coerceNumber()
      .optional()
      .describe("Min Martin instability fanOut / (fanIn + fanOut), in [0,1]. File-level only."),
    minTransitiveImpact: coerceNumber()
      .optional()
      .describe("Min distinct files transitively importing this file (depth-capped reverse BFS). File-level only."),
    minConnectionCount: coerceNumber()
      .optional()
      .describe("Min file-graph edges (fanIn + fanOut); drops low-confidence instability values. File-level only."),
    isHub: coerceBoolean()
      .optional()
      .describe("Files flagged architectural hubs (fanIn above collection p95). File-level only."),
    isLeaf: coerceBoolean().optional().describe("Files flagged leaves (fanOut == 0, fanIn > 0). File-level only."),
  };
}

type TypedFilterCatalog = ReturnType<typeof typedFilterCatalog>;

/** Every typed filter param the MCP catalog can expose (derived from the catalog keys). */
export const TYPED_FILTER_PARAM_NAMES: readonly string[] = Object.keys(typedFilterCatalog());

/**
 * The typed filter fields a search tool exposes: the catalog narrowed to the
 * params a registered trajectory applies (`SchemaBuilder#filterParamNames`).
 * Typed as the full catalog so request DTO typing stays stable — at runtime a
 * gated-off field is absent from the schema, and Zod strips it from requests.
 */
function typedFilterFields(applied: ReadonlySet<string>): TypedFilterCatalog {
  const catalog = typedFilterCatalog();
  return Object.fromEntries(Object.entries(catalog).filter(([param]) => applied.has(param))) as TypedFilterCatalog;
}

const PATH_PATTERN_HINT = "Glob on file path (picomatch), e.g. '**/workflow/**', 'src/**/*.ts'.";

const RERANK_HINT = "Rerank preset or {custom: weights}. See tea-rags://schema/presets.";

const OFFSET_HINT = "Skip first N results (pagination). Default: 0.";

/**
 * Shared fields for query, limit, filter, pathPattern used in semantic/hybrid search.
 */
function searchCommonFields(filterSchema: z.ZodTypeAny) {
  return {
    query: z.string().describe("Search query text"),
    limit: coerceNumber().optional().describe("Maximum number of results (default: 10)"),
    filter: filterSchema.optional(),
    pathPattern: z.string().optional().describe(PATH_PATTERN_HINT),
  };
}

/**
 * Shared level field for all structured search tools. Per-filter level
 * defaults (which filters are level-aware, which default where) are reference
 * prose in tea-rags://schema/overview (`buildOverview`).
 */
function levelField() {
  return {
    level: z
      .enum(["chunk", "file"])
      .optional()
      .describe(
        "'chunk' ranks chunks; 'file' ranks files, file payload only, no content. " +
          "Also scopes level-aware filters. Default: preset signalLevel.",
      ),
  };
}

/**
 * metaOnly hint. The full response contract (raw payload paths, essential git
 * fields, labels only in rankingOverlay) is stated once in
 * tea-rags://schema/overview (`META_ONLY_CONTRACT` in the resources registry).
 */
const META_ONLY_HINT =
  "Drop content. Payload stays raw; labels only in rankingOverlay. Contract: tea-rags://schema/overview.";

/**
 * Shared payload allow-list. Every tool that returns payload-bearing results
 * accepts it, so an agent never has to remember which one does
 * (bd tea-rags-mcp-l2lix).
 */
function fieldsField() {
  return {
    fields: z
      .array(z.string())
      .optional()
      .describe(
        "Payload dot-path allow-list, e.g. ['relativePath', 'git.file.commitCount']. EXACT: nothing added back. " +
          "Paths: tea-rags://schema/signals.",
      ),
  };
}

/** Shared pagination + meta fields for search results. */
function paginationFields(metaOnlyDefault?: boolean) {
  return {
    offset: coerceNumber().optional().describe(OFFSET_HINT),
    metaOnly: coerceBoolean()
      .optional()
      .default(metaOnlyDefault ?? false)
      .describe(`${META_ONLY_HINT} Default: ${metaOnlyDefault ? "true" : "false"}.`),
  };
}

/** Build the shared schema structure used by both semantic_search and hybrid_search. */
function vectorSearchSchema(rerankSchema: z.ZodTypeAny, filterSchema: z.ZodTypeAny, applied: ReadonlySet<string>) {
  return {
    ...collectionPathFields(),
    ...searchCommonFields(filterSchema),
    ...typedFilterFields(applied),
    ...levelField(),
    rerank: rerankSchema.optional().describe(RERANK_HINT),
    ...fieldsField(),
    ...paginationFields(),
  };
}

export function createSearchSchemas(schemaBuilder: SchemaBuilder) {
  // Typed filter params the registered trajectories apply — the only ones a
  // typed-filter tool exposes (bd tea-rags-mcp-86wsz).
  const appliedFilterParams = new Set(schemaBuilder.filterParamNames());

  const semanticSearchRerankSchema = schemaBuilder.buildRerankSchema("semantic_search");
  const searchCodeRerankSchema = schemaBuilder.buildRerankSchema("search_code");
  const rankChunksRerankSchema = schemaBuilder.buildRerankSchema("rank_chunks");
  const findSimilarRerankSchema = schemaBuilder.buildRerankSchema("find_similar");

  // Shared `filter` param: raw Qdrant filter OR { presets } reference, with
  // available filter-preset names surfaced in the description for discovery.
  const filterSchema = schemaBuilder.buildFilterSchema();

  const SemanticSearchSchema = vectorSearchSchema(semanticSearchRerankSchema, filterSchema, appliedFilterParams);
  const HybridSearchSchema = vectorSearchSchema(semanticSearchRerankSchema, filterSchema, appliedFilterParams);

  const SearchCodeSchema = {
    ...collectionPathFields(),
    query: z.string().describe("Natural language search query (e.g., 'authentication logic')"),
    // buildSearchCodeContext defaults to 5, not the 10 the analytic tools use.
    limit: coerceNumber().optional().describe("Maximum number of results (default: 5)"),
    pathPattern: z.string().optional().describe(PATH_PATTERN_HINT),
    ...typedFilterFields(appliedFilterParams),
    rerank: searchCodeRerankSchema.optional().describe(RERANK_HINT),
    offset: coerceNumber().optional().describe(OFFSET_HINT),
  };

  const RankChunksSchema = {
    ...collectionPathFields(),
    ...typedFilterFields(appliedFilterParams),
    rerank: rankChunksRerankSchema.describe(
      "REQUIRED rerank preset or {custom: weights}; similarity weight ignored (no vector). See tea-rags://schema/presets.",
    ),
    ...levelField(),
    limit: coerceNumber().optional().describe("Maximum number of results (default: 10)"),
    filter: filterSchema.optional(),
    pathPattern: z.string().optional().describe(PATH_PATTERN_HINT),
    ...fieldsField(),
    ...paginationFields(true),
    offset: z.coerce.number().int().min(0).optional().default(0).describe(OFFSET_HINT),
  };

  const FindSimilarSchema = {
    ...collectionPathFields(),
    ...levelField(),
    positiveIds: z.array(z.string()).optional().describe("Chunk IDs from previous search results to find similar code"),
    positiveCode: z
      .array(z.string())
      .optional()
      .describe("Code snippets to match — one example per string, embedded on the fly."),
    negativeIds: z.array(z.string()).optional().describe("Chunk IDs to push results away from"),
    negativeCode: z.array(z.string()).optional().describe("Code snippets to push results away from."),
    strategy: z
      .enum(["best_score", "average_vector", "sum_scores"])
      .optional()
      .describe(
        "best_score (default, supports negative-only) | average_vector (fastest) | sum_scores (middle ground).",
      ),
    filter: filterSchema.optional(),
    pathPattern: z.string().optional().describe(PATH_PATTERN_HINT),
    fileExtensions: z.array(z.string()).optional().describe("Filter by file extensions (e.g. ['.ts', '.js'])"),
    rerank: findSimilarRerankSchema.optional().describe(RERANK_HINT),
    limit: coerceNumber().optional().describe("Maximum number of results (default: 10)"),
    ...fieldsField(),
    ...paginationFields(),
  };

  const FindSymbolSchema = {
    symbol: z
      .string()
      .optional()
      .describe(
        "Symbol or symbolId: Class#method (instance), Class.method (static), fn. Partial ok. Excludes relativePath.",
      ),
    relativePath: z.string().optional().describe("File path → outline (code) or heading TOC (docs). Excludes symbol."),
    ...collectionPathFields(),
    language: z
      .string()
      .optional()
      .describe("Filter by programming language (for disambiguation in polyglot codebases)"),
    pathPattern: z
      .string()
      .optional()
      .describe("Glob scoping symbol-mode lookup, e.g. '**/services/**'. Ignored with relativePath."),
    metaOnly: coerceBoolean().optional().describe(`Existence check. ${META_ONLY_HINT}`),
    rerank: semanticSearchRerankSchema
      .optional()
      .describe("Rerank preset or {custom: weights} — attaches rankingOverlay to the definition."),
    ...fieldsField(),
    limit: coerceNumber().optional().describe("Maximum number of results (default: 50)"),
    offset: coerceNumber().optional().describe(OFFSET_HINT),
  };

  return {
    SemanticSearchSchema,
    HybridSearchSchema,
    SearchCodeSchema,
    RankChunksSchema,
    FindSimilarSchema,
    FindSymbolSchema,
  };
}

/** Return type of createSearchSchemas for typing in tool registrations. */
export type SearchSchemas = ReturnType<typeof createSearchSchemas>;
