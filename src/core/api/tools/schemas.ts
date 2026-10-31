/**
 * Consolidated Zod schemas for all MCP tools
 *
 * Note: Schemas are exported as plain objects (not wrapped in z.object()) because
 * McpServer.registerTool() expects schemas in this format. The SDK internally
 * converts these to JSON Schema for the MCP protocol. Each property is a Zod
 * field definition that gets composed into the final schema by the SDK.
 *
 * Search-related schemas (SemanticSearch, HybridSearch, SearchCode) are generated
 * dynamically via createSearchSchemas(SchemaBuilderPort) to avoid hardcoded imports
 * from domain/foundation layers. All other schemas remain static.
 *
 * Param descriptions are INLINE HINTS (≤ 20 words): the one semantic an agent
 * would otherwise get wrong. Reference prose — per-filter level defaults, the
 * metaOnly contract, filter-default resolution — lives in
 * tea-rags://guide/overview (`buildOverview`), which every search tool links.
 * `tests/mcp/tools/param-applicability.test.ts` enforces the budget over the
 * real tools/list (bd tea-rags-mcp-ewg2s).
 */

import { z } from "zod";

import {
  FULL_TEXT_MAX_CHARS,
  FULL_TEXT_MAX_LINES,
  MAX_QUERY_VARIANTS,
  PROJECT_NAME_RE,
  QUERY_VARIANT_SEPARATOR,
  type SchemaBuilderPort,
} from "../public/index.js";

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
/**
 * `project` hint, one string for every project-aware tool (bd tea-rags-mcp-0y5oj:
 * 167 chars × 18 tools before). Resolution priority and the alias-alone case
 * live in tea-rags://guide/overview `## Param reference`.
 */
export const PROJECT_ALIAS_HINT = "Alias from list_projects/prime; pass every call.";

export const projectField = () =>
  z
    .string()
    .regex(PROJECT_NAME_RE, `Project name must match ${PROJECT_NAME_RE.source}`)
    .optional()
    .describe(PROJECT_ALIAS_HINT);

/**
 * `path` hint for every read tool addressed by the { collection, project, path }
 * triad (bd tea-rags-mcp-xi2r9): `resolveWorkingTree` reads `path` as the TREE
 * the caller stands in and finds the index registered for the same repository.
 * One string for the search and codegraph surfaces alike.
 */
export const WORKING_TREE_PATH_HINT = "Your working tree (cwd / worktree); pass WITH project.";

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
    .describe(
      "First-time registration of a NEW codebase root only. Never to reindex an alias (a worktree seeds a separate project).",
    ),
  project: projectField().describe("Registered alias to (re)index — the normal case."),
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
    collection: z.string().optional().describe("Raw collection; prefer project + path."),
    project: projectField(),
    path: z.string().optional().describe(WORKING_TREE_PATH_HINT),
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
    language: z.string().optional().describe("Language."),
    fileExtension: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .describe("'.ts' or ['.ts','.py']."),
    chunkType: z.string().optional().describe("function|class|interface|block"),
    documentation: z.enum(["only", "exclude", "include"]).optional().describe("Preset default may drop docs."),
    testFile: z.enum(["only", "exclude", "include"]).optional().describe("Preset default may drop tests."),
    author: z.string().optional().describe("Blame owner, exact name."),
    recentAuthor: z.string().optional().describe("Top recent committer, name/email."),
    contributor: z.string().optional().describe("Any recent committer, exact name."),
    modifiedAfter: z.string().optional().describe("ISO date."),
    modifiedBefore: z.string().optional().describe("ISO date."),
    minAgeDays: coerceNumber().optional().describe("Last commit ≥ N days ago."),
    maxAgeDays: coerceNumber().optional().describe("Last commit ≤ N days ago."),
    minCommitCount: coerceNumber().optional().describe("Min commits."),
    taskId: z.string().optional().describe("Commit task ID."),
    symbolId: z.string().optional().describe("Partial symbolId."),
    // Codegraph trajectory — names map to nested Qdrant paths in codegraphFilters.toCondition().
    minFanIn: coerceNumber().optional().describe("Min fan-in."),
    minFanOut: coerceNumber().optional().describe("Min fan-out."),
    minPageRank: coerceNumber().optional().describe("0-1."),
    minInstability: coerceNumber().optional().describe("File-level, 0-1."),
    minTransitiveImpact: coerceNumber().optional().describe("File-level."),
    minConnectionCount: coerceNumber().optional().describe("File-level."),
    isHub: coerceBoolean().optional().describe("File-level."),
    isLeaf: coerceBoolean().optional().describe("File-level."),
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

const PATH_PATTERN_HINT = "Picomatch glob, e.g. 'src/**/*.ts'.";

/**
 * The custom arm is an open map (bd tea-rags-mcp-0y5oj) — the hint names where
 * its keys come from; an unknown key is rejected server-side.
 */
const RERANK_HINT = "Preset or {custom:{<signal>:weight}}; tea-rags://guide/signals.";

const OFFSET_HINT = "Pagination offset.";

/**
 * Shared fields for query, limit, filter, pathPattern used in semantic/hybrid search.
 */
function searchCommonFields(filterSchema: z.ZodTypeAny) {
  return {
    query: z
      .union([z.string(), z.array(z.string()).min(1).max(MAX_QUERY_VARIANTS)])
      .describe(`Text or ≤${MAX_QUERY_VARIANTS} variants (array / 'a ${QUERY_VARIANT_SEPARATOR} b'), fused.`),
    limit: coerceNumber().optional().describe("Default 10."),
    filter: filterSchema.optional(),
    pathPattern: z.string().optional().describe(PATH_PATTERN_HINT),
  };
}

/**
 * Shared level field for all structured search tools. Per-filter level
 * defaults (which filters are level-aware, which default where) are reference
 * prose in tea-rags://guide/overview (`buildOverview`).
 */
function levelField() {
  return {
    level: z.enum(["chunk", "file"]).optional().describe("'file' ranks files; scopes level-aware filters."),
  };
}

/**
 * metaOnly hint. The full response contract (default locator payload, raw signals
 * via fields, labels only in rankingOverlay) is stated once in
 * tea-rags://guide/overview (`META_ONLY_CONTRACT` in the resources registry).
 */
const META_ONLY_HINT = "Locator rows, no content.";

/**
 * find_symbol keeps its own lean per-mode default. A search tool's `fields`
 * default is stated in tea-rags://guide/overview, interpolated there from the
 * constants the projection applies (bd tea-rags-mcp-q1g6s.16) — the alwaysLoad
 * hint stays one clause (bd tea-rags-mcp-d0z7b.5).
 */
const LOOKUP_FIELDS_OMITTED_HINT = "; omitted → lean per mode";

/**
 * Shared payload allow-list. Every tool that returns payload-bearing results
 * accepts it, so an agent never has to remember which one does
 * (bd tea-rags-mcp-l2lix).
 */
function fieldsField(omittedHint = "") {
  return {
    fields: z
      .array(z.string())
      .optional()
      .describe(`Payload dot-paths (relativePath kept)${omittedHint}; tea-rags://guide/signals.`),
    ...includeImportsField(),
  };
}

/**
 * `imports` goes out as a COUNT by default (bd tea-rags-mcp-e6es3) — the list
 * was ~38% of a reranked answer. Rides with `fields` because it shapes the
 * same payload; applied by `compactSearchResults` in the MCP formatter.
 */
function includeImportsField() {
  return {
    includeImports: coerceBoolean().optional().describe("true → full import lists."),
  };
}

/** Shared pagination + meta fields for search results. */
function paginationFields(metaOnlyDefault?: boolean) {
  return {
    offset: coerceNumber().optional().describe(OFFSET_HINT),
    metaOnly: coerceBoolean()
      .optional()
      .default(metaOnlyDefault ?? false)
      .describe(META_ONLY_HINT),
  };
}

/** Build the shared schema structure used by both semantic_search and hybrid_search. */
function vectorSearchSchema(rerankSchema: z.ZodTypeAny, filterSchema: z.ZodTypeAny, applied: ReadonlySet<string>) {
  return {
    ...collectionPathFields(),
    scope: z.enum(["code", "migrations"]).optional().describe("migrations = Rails schema history."),
    ...searchCommonFields(filterSchema),
    ...typedFilterFields(applied),
    ...levelField(),
    rerank: rerankSchema.optional().describe(RERANK_HINT),
    ...fieldsField(),
    ...paginationFields(),
  };
}

export function createSearchSchemas(schemaBuilder: SchemaBuilderPort) {
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
      "REQUIRED preset or {custom: {<signal>: number}} (tea-rags://guide/signals); similarity ignored (no vector).",
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
    positiveIds: z
      .array(z.string())
      .optional()
      .describe("symbolIds (or point ids) from previous results to find similar code"),
    positiveCode: z
      .array(z.string())
      .optional()
      .describe("Code snippets to match — one example per string, embedded on the fly."),
    negativeIds: z.array(z.string()).optional().describe("symbolIds (or point ids) to push results away from"),
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
    symbol: z.string().optional().describe("Class#method, Class.method, fn; partial ok. Excludes relativePath."),
    symbols: z
      .array(z.string())
      .min(1)
      .max(20)
      .optional()
      .describe(
        `1-20 symbol ids / file paths; ≤${FULL_TEXT_MAX_LINES} lines or ≤${FULL_TEXT_MAX_CHARS} chars → full text, else outline. Excludes symbol, relativePath.`,
      ),
    relativePath: z
      .string()
      .optional()
      .describe(
        `File ≤${FULL_TEXT_MAX_LINES} lines or ≤${FULL_TEXT_MAX_CHARS} chars → full text, else outline; dir → listing. Excludes symbol.`,
      ),
    ...collectionPathFields(),
    language: z.string().optional().describe("Language."),
    pathPattern: z.string().optional().describe("Glob; ignored with relativePath."),
    metaOnly: coerceBoolean().optional().describe(`Existence check. ${META_ONLY_HINT}`),
    rerank: semanticSearchRerankSchema
      .optional()
      .describe("Preset or {custom: {<signal>: weight}} (tea-rags://guide/signals) → rankingOverlay."),
    ...fieldsField(LOOKUP_FIELDS_OMITTED_HINT),
    limit: coerceNumber().optional().describe("Default 50."),
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
