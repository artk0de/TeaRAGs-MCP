/**
 * Codegraph MCP tools — slice 1: get_callers, get_callees.
 * Slice 2 adds: find_cycles. Slice 6 adds: trace_path.
 * get_architecture_report (bd tea-rags-mcp-94hd9) judges the file graph.
 *
 * All tools read directly from the codegraph DuckDB via the App's
 * GraphFacade (wired in createApp()).
 *
 * Addressing: every tool accepts the standard `{ collection, project,
 * path }` triad (resolution priority: collection > project > path) —
 * same shape every other tea-rags tool exposes. `path` stays as the
 * backward-compatible fallback so existing path-only callers keep
 * working; project alias is the recommended way to address an indexed
 * codebase.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type {
  FindCoChangedRequest,
  FindCyclesRequest,
  GetArchitectureReportRequest,
  GetCalleesRequest,
  GetCallersRequest,
  GetOntologyReportRequest,
  NamingLexiconRequest,
  TracePathRequest,
} from "../../core/api/public/dto/index.js";
import {
  CODEGRAPH_SYMBOLS_PROVIDER_KEY,
  PROJECT_NAME_RE,
  type App,
  type SchemaBuilder,
} from "../../core/api/public/index.js";
import { formatMcpText, type McpToolResult } from "../format.js";
import type { RegisterToolFn } from "../middleware/error-handler.js";

/**
 * Shared `{ collection, project, path }` triad for codegraph tools.
 * Mirrors `collectionPathFields()` in `mcp/tools/schemas.ts` and the
 * `SchemaBuilder.collectionIdentifier()` mixin — kept inline here
 * because the codegraph tool surface is independent of the dynamic
 * search-tool schema pipeline. Resolution priority: collection >
 * project > path. Exported for the codegraph-family registrars that
 * live in their own files (`review-changes.ts`).
 */
export function collectionPathFields() {
  return {
    project: z
      .string()
      .regex(PROJECT_NAME_RE, `Project name must match ${PROJECT_NAME_RE.source}`)
      .optional()
      .describe(
        "[RECOMMENDED] Registered project alias; survives path moves. Resolution priority: collection > project > path.",
      ),
    collection: z.string().optional().describe("Raw Qdrant collection name — lowest-level handle; prefer 'project'."),
    path: z
      .string()
      .optional()
      .describe("Indexed codebase path; auto-resolves to its collection. Prefer 'project' when aliased."),
  };
}

/** Host-class aliasing contract shared by get_callers / get_callees (bd tea-rags-mcp-63l69). */
const RESOLVED_SYMBOL_ID_CONTRACT =
  "Host-class id with no node of its own (Account.suspended, member defined in an included module or " +
  "superclass) → answered via first definer up hierarchy in MRO order; resolvedSymbolId names the id queried. ";

const GetCallersInputShape = {
  ...collectionPathFields(),
  symbolId: z
    .string()
    .optional()
    .describe("Target symbol id (e.g. Foo.bar). Provide exactly one of 'symbolId' / 'relativePath'."),
  relativePath: z
    .string()
    .optional()
    .describe(
      "Target FILE, repo-relative (e.g. src/core/app.ts) — file scope: returns the files importing it. " +
        "Provide exactly one of 'symbolId' / 'relativePath'.",
    ),
  limit: z.number().int().positive().max(500).optional().describe("Max caller edges / importer files (default 50)"),
  includeAmbiguous: z
    .boolean()
    .optional()
    .describe(
      "Also attach ambiguousCallers: member-matched dispatch sites that MAY reach target, not edges. Default false.",
    ),
};

const GetCalleesInputShape = {
  ...collectionPathFields(),
  symbolId: z
    .string()
    .optional()
    .describe("Source symbol id (e.g. main). Provide exactly one of 'symbolId' / 'relativePath'."),
  relativePath: z
    .string()
    .optional()
    .describe(
      "Source FILE, repo-relative (e.g. src/core/app.ts) — file scope: returns the files it imports. " +
        "Provide exactly one of 'symbolId' / 'relativePath'.",
    ),
  limit: z.number().int().positive().max(500).optional().describe("Max callee edges / imported files (default 50)"),
};

const FindCyclesInputShape = {
  ...collectionPathFields(),
  scope: z
    .enum(["file", "method"])
    .default("file")
    .describe("'file' = circular imports between files; 'method' = circular calls between symbols"),
  pathPattern: z
    .string()
    .optional()
    .describe(
      "Glob scoping cycles, e.g. '**/domains/ingest/**'. Cycle kept when ≥1 member file matches (cross-boundary stays).",
    ),
};

const GetArchitectureReportInputShape = {
  ...collectionPathFields(),
  pathPattern: z
    .string()
    .optional()
    .describe(
      "Glob scoping judged edges by SOURCE file. Instability, adoption and layer levels stay whole-graph. Omit for whole project.",
    ),
  domain: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Directory root judged AS ITS OWN SYSTEM: induced sub-graph, every metric recomputed inside; " +
        "response.domain carries border edges with whole-graph levels.",
    ),
  norms: z
    .boolean()
    .optional()
    .describe(
      "Judge typed file edges against the project's own role precedents: response.norms + norms " +
        "violations (MISFIT with expected path, NEW_PATTERN).",
    ),
  limit: z
    .number()
    .int()
    .positive()
    .max(500)
    .optional()
    .describe("Max violations and max root causes per detector (default 50). Summary keeps totals."),
  layerMap: z
    .object({
      scopePathPattern: z.string().optional(),
      granularity: z.enum(["directory", "file"]).optional(),
      directoryDepth: z.number().int().min(0).max(10).optional(),
    })
    .optional()
    .describe(
      "Also return the layer map VIEW: levels per node in scopePathPattern, boundary edges with global levels, move candidates.",
    ),
  knotOf: z
    .string()
    .optional()
    .describe("Component path from drillDown: return its knot view and the findings inside it, paged by limit/offset"),
  offset: z.number().int().min(0).optional().describe("Page start for the knotOf view"),
};

/**
 * `get_ontology_report` input (bd tea-rags-mcp-4p3sb.20). Call contract only —
 * when to call is the search cascade's job; the budget is pinned by
 * `ontology-report-tool.test.ts`.
 */
const GetOntologyReportInputShape = {
  ...collectionPathFields(),
  pathPattern: z.string().optional().describe("Glob scope; its literal prefix filters files. Omit for whole project."),
  language: z.string().optional().describe("Only this language's files."),
  sections: z
    .array(z.enum(["synonyms", "homonyms", "outliers", "collisions", "verbs"]))
    .optional()
    .describe("Sections (default all but verbs: per noun tail, the method verbs with holders)."),
  limit: z.number().int().positive().max(100).optional().describe("Items per section (default 20)."),
};

/** `find_co_changed` (bd tea-rags-mcp-l1ot.1) — co-change partners of the named files. */
const FindCoChangedInputShape = {
  ...collectionPathFields(),
  files: z
    .array(z.string().min(1))
    .min(1)
    .describe("Project-relative paths to query, at least one (e.g. ['src/core/app.ts'])."),
  limit: z.number().int().positive().max(100).optional().describe("Max partners per file (default 10)"),
};

/**
 * Build the `trace_path` input shape. The `rerank` field is a curated preset
 * ENUM derived from the registry (presets that tag `"trace_path"` in their
 * `tools[]`), NOT a free string — a bad preset is rejected at the MCP boundary
 * instead of silently degrading to similarity-only inside the reranker.
 * `schemaBuilder.buildPresetSchema("trace_path")` is the single source of truth;
 * `.optional()` keeps the field omittable — there is no default. Omitting it
 * yields a lean trace (no danger ranking); pass a preset to opt into the overlay.
 */
function buildTracePathInputShape(schemaBuilder: SchemaBuilder) {
  return {
    ...collectionPathFields(),
    from: z.string().describe("Start symbol id (caller end, e.g. main)"),
    to: z.string().describe("End symbol id (callee end, e.g. Foo.bar)"),
    fromPath: z
      .string()
      .optional()
      .describe("Exact relative path pinning 'from' when its id names several files. Omit → all, listed as namesakes."),
    toPath: z.string().optional().describe("Exact relative path pinning 'to'. Same semantics as fromPath."),
    rerank: schemaBuilder
      .buildPresetSchema("trace_path")
      .optional()
      .describe("Danger preset scoring each step for the overlay. Omit for lean path enumeration."),
    maxDepth: z
      .number()
      .int()
      .positive()
      .max(20)
      .optional()
      .describe("Max hops per path (default 8, cap 20 — deep traces on dense graphs are expensive)."),
    maxPaths: z
      .number()
      .int()
      .positive()
      .max(50)
      .optional()
      .describe("Max paths returned (default 10; danger-sorted only when rerank passed)"),
  };
}

/**
 * `get_naming_lexicon` (bd tea-rags-mcp-4p3sb.12) — COMPACT by contract: the
 * description states the call contract only (when to call is selection policy,
 * owned by the search cascade), each field one line, no examples. A test holds
 * the description ≤ 300 chars and the input schema, as clients receive it,
 * ≤ 1.5 KB serialized.
 */
const NAMING_LEXICON_DESCRIPTION =
  "Codegraph naming. `types`/`anchors`→names/kind+shape; " +
  "`names[]`(attr:field; method:return; class/const:type+path)→CONFORMS(vocabulary, not behaviour)|" +
  "MISFIT{suggestion}|NEW_TERM{topTerms}|NO_CONVENTION{prefer}|COLLISION,+alternatives,genericName; " +
  "`concept`+`language`→terms.";

function buildNamingLexiconInputSchema() {
  const draftName = z.object({
    name: z.string().min(1),
    kind: z
      .enum(["param", "local", "field", "return", "type"])
      .optional()
      .describe("ivar/attribute/property: field; method: return, type=result type"),
    type: z.string().optional(),
    typeMultiplicity: z.enum(["one", "many"]).optional().describe("many: type=element"),
    callee: z.object({ member: z.string().min(1), receiver: z.string().optional() }).optional(),
    path: z.string().optional(),
    extends: z.string().optional(),
  });
  return z
    .object({
      ...collectionPathFields(),
      pathPattern: z.string().optional().describe("Glob"),
      language: z.string().optional(),
      types: z.array(z.string()).optional(),
      anchors: z.array(z.string()).optional().describe("SymbolIds: +param/return types"),
      concept: z.string().optional().describe("Domain, not a name"),
      names: z.array(draftName).optional(),
    })
    .refine(
      (req) =>
        (req.types?.length ?? 0) > 0 ||
        (req.anchors?.length ?? 0) > 0 ||
        (req.names?.length ?? 0) > 0 ||
        (req.concept ?? "").length > 0,
      { message: "Provide at least one of types, anchors, concept, names" },
    )
    .refine((req) => req.concept === undefined || req.language !== undefined, {
      message: "concept requires language",
      path: ["language"],
    })
    .refine((req) => (req.names ?? []).every((draft) => draft.kind !== "type" || draft.path !== undefined), {
      message: "a kind 'type' draft requires path",
      path: ["names"],
    });
}

/**
 * Input schema per codegraph tool, built once per registration — the two
 * dynamic rows need it (`trace_path` derives its preset enum from the live
 * registry via the SchemaBuilder, `get_naming_lexicon` compiles its refined
 * object).
 */
function createCodegraphSchemas(schemaBuilder: SchemaBuilder) {
  return {
    get_callers: GetCallersInputShape,
    get_callees: GetCalleesInputShape,
    find_cycles: FindCyclesInputShape,
    get_architecture_report: GetArchitectureReportInputShape,
    get_ontology_report: GetOntologyReportInputShape,
    find_co_changed: FindCoChangedInputShape,
    trace_path: buildTracePathInputShape(schemaBuilder),
    get_naming_lexicon: buildNamingLexiconInputSchema(),
  };
}
type CodegraphSchemas = ReturnType<typeof createCodegraphSchemas>;

/**
 * One row of the codegraph tool table — same shape as `SearchToolDef` in
 * explore.ts. The SDK's zod parse strips unknown keys and applies defaults, so
 * `invoke` receives exactly the schema's fields and casts the parsed input to
 * the App method's request DTO.
 */
interface CodegraphToolDef {
  name: string;
  title: string;
  description: string;
  schemaKey: keyof CodegraphSchemas;
  invoke: (app: App, request: unknown) => Promise<McpToolResult>;
}

const CODEGRAPH_TOOLS: readonly CodegraphToolDef[] = [
  {
    name: "get_callers",
    title: "Get Callers",
    description:
      `Return symbols that invoke given symbolId. Backed by codegraph DuckDB. ${RESOLVED_SYMBOL_ID_CONTRACT}` +
      "Top-level visibility = queried symbol's declared level; each caller carries its own " +
      "(private|protected|public; absent = unknown). " +
      "Pass includeAmbiguous:true to also list ambiguous dispatch sites (member-matched, " +
      "MAY reach target among candidateCount candidates; not materialized as edges). " +
      "File scope: pass relativePath instead of symbolId → {relativePath, importers[], total} — " +
      "files that import it, each {relativePath, importText, callWeight}, heaviest callWeight first; " +
      "unknown file → empty importers + message.",
    schemaKey: "get_callers",
    invoke: async (app, request) =>
      formatMcpText(JSON.stringify(await app.getCallers(request as GetCallersRequest), null, 2)),
  },
  {
    name: "get_callees",
    title: "Get Callees",
    description:
      `Return symbols invoked by given symbolId. Backed by codegraph DuckDB. ${RESOLVED_SYMBOL_ID_CONTRACT}` +
      "Each callee carries the target's declared visibility (private|protected|public; absent = unknown). " +
      "File scope: pass relativePath instead of symbolId → {relativePath, imports[], total} — " +
      "files it imports, each {relativePath, importText, callWeight}, heaviest callWeight first; " +
      "unknown file → empty imports + message.",
    schemaKey: "get_callees",
    invoke: async (app, request) =>
      formatMcpText(JSON.stringify(await app.getCallees(request as GetCalleesRequest), null, 2)),
  },
  {
    name: "find_cycles",
    title: "Find Cycles",
    description:
      "Return strongly-connected components (cycles) from import or call graph. " +
      "Cycles length >= 2; single-node 'cycles' excluded. Read from pre-computed " +
      "table — sub-millisecond per call. scope=method: members are symbol ids and " +
      "memberLocations lists {symbolId, relativePath} per member in the same order — " +
      "namesakes in different files are distinct members; an empty relativePath means " +
      "the cycle was not recomputed since the index upgrade.",
    schemaKey: "find_cycles",
    invoke: async (app, request) =>
      formatMcpText(JSON.stringify(await app.findCycles(request as FindCyclesRequest), null, 2)),
  },
  {
    name: "get_architecture_report",
    title: "Get Architecture Report",
    description:
      "Architecture diagnostics: is code laid out correctly (NOT is it risky to touch — use risk-assessment). " +
      "Typed violations with per-line evidence, per detector; scripts/spikes/benchmarks/examples/fixtures excluded. " +
      "stableDependencies (Stable Dependencies Principle): stable COMPONENT depending on less stable one — " +
      "component = module with measured facade, else directory; evidence = instabilities, Ca/Ce, delta, carrying " +
      "file edges; dependency on nested component not judged; rootCauses by unstable target component, " +
      "cycleWithDependents = target depends on own dependents. leakingAbstraction: " +
      "import past a module facade (index.ts/__init__.py/mod.rs) its importers adopted (>=3 importers, " +
      "adoption >0.5 and >= adaptive Otsu cut; summary gives threshold, method, separability); kind " +
      "bypass = facade re-exports what import takes (by imported names when indexed, else target file), " +
      "internal-reach = it does not (nonExportedNames), conventionPrivacy = Python _name " +
      "used from other package or Ruby send(:private) from outside its class; rootCauses per module. " +
      "silentCoupling: file pair co-changing strongly in git history with no import/re-export/resolved call " +
      "between them (support, P(B|A), P(A|B), lift, strength = Wilson lower bound, sample commits, " +
      "structuralVisibility); strong = >0.5 and >= adaptive Otsu cut; rootCauses = file with >=2 silent " +
      "partners; summary.silentCoupling.built false = no co-change build, not clean. mainSequence " +
      "(Stable Abstractions Principle): component far from A+I=1 — pain = stable+concrete, uselessness = " +
      "unstable+abstract; A from walker type census, D > max(0.5, Otsu cut); components whose language " +
      "rarely declares abstractions excluded (unobservableAbstractness); census needs codegraph recompute; pain " +
      "also needs volatility (mean git.file.commitCount per file > max(median file, log-scale Otsu cut)), calm ones " +
      "counted as stableConcreteCalm. layering: inferred layers without a declared architecture — SCC-condensed " +
      "DOMAIN graph (every facade directory is a unit, adoption notwithstanding — a vertical with an unadopted " +
      "facade counts once, not once per subdirectory; facadePartition keeps the adoption partition's component/level " +
      "counts), levels by longest path (L0 = foundation), per-knot greedy weighted feedback arc set " +
      "(cut these N edges -> k levels); knot lists top-20 members by Ca + memberCount, top-10 cut edges by " +
      "weight + cutEdgeCount total, evidence.drillDown names the knotOf handle; a knotOf call returns that knot " +
      "(members with I/Ca/Ce, cut edges with keepCost — recollapsedMemberCount 0 = needless cut, paged) plus only " +
      "the findings inside it on offset 0, not the project " +
      "report (summary stays whole-project); violations knot (ranked by " +
      "member-instability spread — spread > 0 is an SDP break inside the cycle) / backEdge (minority-weight direction, equal weights never " +
      "guessed) / abstractionBypass (consumer reaches measured-concrete component past measured-abstract one beneath); " +
      "informational compositionCycle / island (nothing depends on it, below the top) / layerSkip (>=2 levels straight " +
      "down); summary.layering: coverage, levelCount, coherence (rank correlation level vs instability). layerMap " +
      "option: also return the map VIEW — levels per node in scopePathPattern (file|directory granularity, directoryDepth " +
      "collapse), boundary edges with the outside component's global level, move candidates; absent unless asked. domain " +
      "option: judge one directory AS ITS OWN SYSTEM (induced sub-graph, every metric recomputed inside — unlike " +
      "pathPattern which filters findings only); response.domain carries its layering counts + border edges naming the " +
      "external component and its whole-graph level. norms " +
      "option: the project's own dependency precedents per (roleSrc, roleDst, locality) from primary-type roles — " +
      "norms violations flag a MISFIT (with the expected transit path) or a NEW_PATTERN edge. Summary " +
      "counts exclusions with named reasons. Diagnosis, not prescription.",
    schemaKey: "get_architecture_report",
    invoke: async (app, request) =>
      formatMcpText(JSON.stringify(await app.getArchitectureReport(request as GetArchitectureReportRequest), null, 2)),
  },
  {
    name: "get_ontology_report",
    title: "Get Ontology Report",
    description:
      "Project-wide naming ontology audit from the codegraph. synonyms: one type, many names; " +
      "homonyms: one name, many types; outliers: names off their type's dominant shape; " +
      "collisions: names equal to other symbols. Ranked, with counts and an example each.",
    schemaKey: "get_ontology_report",
    invoke: async (app, request) =>
      formatMcpText(JSON.stringify(await app.getOntologyReport(request as GetOntologyReportRequest), null, 2)),
  },
  {
    name: "find_co_changed",
    title: "Find Co-Changed Files",
    description:
      "File co-change partners from git history (cg_temporal sub-graph). Ranked by Wilson lower-bound strength; " +
      "each partner carries support, both directed confidences (pPartnerGivenFile, pFileGivenPartner), lift, " +
      "sample commits, structurallyLinked — an import/method/barrel edge joins the pair, false = silent coupling. " +
      "Provenance echoes head, window and build cuts; partners deleted from the working tree are dropped. " +
      "built:false = no co-change build yet (run a codegraph enrichment), NEVER read it as 'no partners'. " +
      "Before editing a file, surface silent high-strength partners as change-context.",
    schemaKey: "find_co_changed",
    invoke: async (app, request) =>
      formatMcpText(JSON.stringify(await app.findCoChanged(request as FindCoChangedRequest), null, 2)),
  },
  {
    name: "trace_path",
    title: "Trace Path",
    description:
      "Trace all simple call paths from one symbol to another, in execution order. " +
      "Lean path enumeration by default. Pass `rerank` danger preset to annotate each step " +
      "with git/churn overlay and sort paths most-dangerous first. Steps carry declared visibility " +
      "when known (absent = unknown). Backed by codegraph DuckDB. " +
      "from/to: host-class id with no node of its own → traced via the member's first definer up " +
      "hierarchy in MRO order; resolvedEndpoints names the id traced.",
    schemaKey: "trace_path",
    // `TracePathRequest.rerank` is the string preset name the curated enum
    // (z.ZodTypeAny erases to unknown after .optional()) narrows to.
    invoke: async (app, request) =>
      formatMcpText(JSON.stringify(await app.tracePath(request as TracePathRequest), null, 2)),
  },
  {
    name: "get_naming_lexicon",
    title: "Get Naming Lexicon",
    description: NAMING_LEXICON_DESCRIPTION,
    schemaKey: "get_naming_lexicon",
    invoke: async (app, request) =>
      formatMcpText(JSON.stringify(await app.getNamingLexicon(request as NamingLexiconRequest), null, 2)),
  },
];

export function registerCodegraphTools(
  server: McpServer,
  deps: { app: App; schemaBuilder: SchemaBuilder; register: RegisterToolFn },
): void {
  const { app, schemaBuilder, register: registerToolSafe } = deps;

  // Provider gating — when codegraph.symbols isn't registered, none of these
  // tools should appear in the MCP `list_tools` response. Silent no-op
  // (no error, no log) — the upstream gate at composition is what controls
  // the surface.
  if (!app.hasProvider(CODEGRAPH_SYMBOLS_PROVIDER_KEY)) return;

  const schemas = createCodegraphSchemas(schemaBuilder);
  for (const tool of CODEGRAPH_TOOLS) {
    registerToolSafe(
      server,
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: schemas[tool.schemaKey],
        annotations: { readOnlyHint: true, idempotentHint: true },
      },
      async (request: unknown) => tool.invoke(app, request),
    );
  }
}
