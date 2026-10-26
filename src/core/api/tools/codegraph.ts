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

import {
  ARCHITECTURE_PLANNED_EDGE_LIMIT,
  ARCHITECTURE_REPORT_DETECTORS,
  ARCHITECTURE_REPORT_EVIDENCE_LIMIT,
  ARCHITECTURE_RESTRUCTURE_OP_LIMIT,
  ARCHITECTURE_RESTRUCTURE_PLAN_CANDIDATE_LIMIT,
  CODEGRAPH_SYMBOLS_PROVIDER_KEY,
  type App,
  type FindCoChangedRequest,
  type FindCyclesRequest,
  type GetArchitectureReportRequest,
  type GetCalleesRequest,
  type GetCallersRequest,
  type GetOntologyReportRequest,
  type NamingLexiconRequest,
  type SchemaBuilderPort,
  type TracePathRequest,
} from "../public/index.js";
import { formatMcpResponse, type McpToolResult } from "./format.js";
import type { RegisterToolFn } from "./middleware/error-handler.js";
import { offsetContinuation, type ResponseRowsPolicy } from "./response-budget.js";
import { projectField, WORKING_TREE_PATH_HINT } from "./schemas.js";

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
    project: projectField(),
    collection: z.string().optional().describe("Raw collection; prefer project + path."),
    path: z.string().optional().describe(WORKING_TREE_PATH_HINT),
  };
}

/** Host-class aliasing contract shared by get_callers / get_callees (bd tea-rags-mcp-63l69). */
const RESOLVED_SYMBOL_ID_CONTRACT =
  "Host-class id with no node of its own (Account.suspended, member defined in an included module or " +
  "superclass) → answered via first definer up hierarchy in MRO order; resolvedSymbolId names the id queried. ";

/** Empty-answer contract shared by get_callers / get_callees (agent turn economy N6). */
const EMPTY_GRAPH_ANSWER_CONTRACT =
  "Wrong separator (Foo.bar for instance member) → swapped id answered, named in resolvedSymbolId. " +
  "Empty answer carries empty {reason, message, suggestions?}: unknownSymbol (no node; suggestions = ids " +
  "with same short name), noEdges (node, no edges; message flags lower bound when language resolve rate < 0.9), " +
  "unknownFile.";

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

/** One restructure hypothesis' op list — restructure mode takes one, each restructurePlan candidate carries one. */
const ArchitectureRestructureOpListSchema = z
  .array(
    z.union([
      z.object({ move: z.object({ files: z.array(z.string().min(1)).min(1), toComponent: z.string() }) }),
      z.object({ merge: z.object({ components: z.array(z.string()).min(2) }) }),
      z.object({
        split: z.object({ component: z.string(), groups: z.array(z.array(z.string().min(1)).min(1)).min(1) }),
      }),
      z.object({
        addFile: z.object({
          file: z.string().min(1),
          component: z.string().optional(),
          abstract: z.boolean().optional(),
        }),
      }),
      z.object({ addEdge: z.object({ from: z.string().min(1), to: z.string().min(1) }) }),
      z.object({ removeEdge: z.object({ from: z.string().min(1), to: z.string().min(1) }) }),
    ]),
  )
  .min(1)
  .max(ARCHITECTURE_RESTRUCTURE_OP_LIMIT);

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
      "Role-pair norms: response.norms + violations for edges against their role pair's established " +
        "direction (MISFIT).",
    ),
  changeReasons: z
    .boolean()
    .optional()
    .describe(
      "response.changeReasons: per component, distinct domains of tickets that changed it; " +
        "ticket domain = dominant OTHER component touched.",
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
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "Violations skipped per detector, after ranking; with reportId pages one judgement. Knot mode: pages the knotOf view.",
    ),
  reportId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Previous answer's reportId: page it without recompute. MCP server memory only (CLI call recomputes); re-editing changed files undetected until TTL.",
    ),
  evidenceLimit: z
    .union([z.number().int().positive().max(500), z.literal("all")])
    .optional()
    .describe(
      `Max entries per violation evidence array (default ${ARCHITECTURE_REPORT_EVIDENCE_LIMIT}); "all" = untrimmed. Trimmed group -> next call restores it.`,
    ),
  detectors: z
    .array(z.enum(ARCHITECTURE_REPORT_DETECTORS))
    .min(1)
    .optional()
    .describe("Return only these detectors' violation groups. Summary keeps all totals."),
  includeExplainedPairs: z
    .boolean()
    .optional()
    .describe("List summary.silentCoupling.explainedPairs; default only explainedPairCount."),
  plannedEdges: z
    .array(z.object({ source: z.string().min(1), target: z.string().min(1), reference: z.string().optional() }))
    .min(1)
    .max(ARCHITECTURE_PLANNED_EDGE_LIMIT)
    .optional()
    .describe(
      "File pairs source->target about to be written: verdicts only, no report; other options rejected. reference = name used.",
    ),
  restructure: ArchitectureRestructureOpListSchema.optional().describe(
    "One what-if hypothesis: violation delta vs current partition, no report; only limit may ride along.",
  ),
  restructurePlan: z
    .object({
      candidates: z
        .array(
          z.object({
            id: z.string().min(1),
            rationale: z.string().optional(),
            ops: ArchitectureRestructureOpListSchema,
          }),
        )
        .max(ARCHITECTURE_RESTRUCTURE_PLAN_CANDIDATE_LIMIT),
      includeReportCandidates: z.boolean().optional(),
    })
    .optional()
    .describe(
      "Order candidate hypotheses greedily; ids unique, not report:-prefixed; report split/merge added unless false.",
    ),
};

/**
 * The wire shape and `GetArchitectureReportRequest` are ONE contract,
 * declared here rather than co-changed in heads (bd tea-rags-mcp-89k7k.25):
 * the silent-coupling detector flagged this tool file as changing as a set
 * with the report DTO and its detector engines, because a request field used
 * to be added to one side with no declared link to the other. A field added
 * to either side without the other now fails compilation right here.
 */
type GetArchitectureReportShapeAlignment = [
  Exclude<keyof z.infer<z.ZodObject<typeof GetArchitectureReportInputShape>>, keyof GetArchitectureReportRequest>,
] extends [never]
  ? [
      Exclude<keyof GetArchitectureReportRequest, keyof z.infer<z.ZodObject<typeof GetArchitectureReportInputShape>>>,
    ] extends [never]
    ? true
    : never
  : never;
const _getArchitectureReportShapeAligned: GetArchitectureReportShapeAlignment = true;

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
function buildTracePathInputShape(schemaBuilder: SchemaBuilderPort) {
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
  "MISFIT{suggestion}|NEW_TERM{topTerms}|NO_CONVENTION{prefer}|COLLISION,+alternatives,borderline,genericName; " +
  "`concept`+`language`→terms. Diff names: review_changes naming, never hand-listed.";

/** Diff-review params `get_naming_lexicon` dropped when `review_changes` took them over (bd tea-rags-mcp-89k7k). */
const REMOVED_NAMING_LEXICON_DIFF_PARAMS = ["changes", "files"] as const;

function buildNamingLexiconInputSchema() {
  const draftName = z.object({
    name: z.string().min(1),
    kind: z
      .enum(["param", "local", "field", "constant", "return", "type"])
      .optional()
      .describe("ivar/attribute/property: field; static/global immutable: constant; method: return, type=result type"),
    type: z.string().optional(),
    typeMultiplicity: z.enum(["one", "many"]).optional().describe("many: type=element"),
    callee: z.object({ member: z.string().min(1), receiver: z.string().optional() }).optional(),
    path: z.string().optional(),
    extends: z.string().optional(),
    symbolKind: z.enum(["class", "module", "interface", "enum", "type_alias", "constant"]).optional(),
  });
  return (
    z
      .object({
        ...collectionPathFields(),
        pathPattern: z.string().optional().describe("Glob"),
        language: z.string().optional(),
        types: z.array(z.string()).optional(),
        anchors: z.array(z.string()).optional().describe("SymbolIds: +param/return types"),
        concept: z.string().optional().describe("Domain, not a name"),
        names: z.array(draftName).optional(),
      })
      // bd tea-rags-mcp-89k7k.1.15: the default strip dropped the removed
      // `changes`/`files` params before any refine saw them, so a stale caller
      // got a vocabulary answer and believed it had reviewed a diff. `loose`
      // keeps them visible to the check below. Not `strict`: no other MCP tool
      // schema rejects unknown keys, and only these two carry a meaning a caller
      // can still rely on.
      .loose()
      .superRefine((req, ctx) => {
        for (const removed of REMOVED_NAMING_LEXICON_DIFF_PARAMS) {
          if (removed in req) {
            ctx.addIssue({
              code: "custom",
              path: [removed],
              message: `'${removed}' was removed: diff review moved to review_changes (sections: ["naming"])`,
            });
          }
        }
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
      })
  );
}

/**
 * Input schema per codegraph tool, built once per registration — the two
 * dynamic rows need it (`trace_path` derives its preset enum from the live
 * registry via the SchemaBuilder, `get_naming_lexicon` compiles its refined
 * object).
 */
function createCodegraphSchemas(schemaBuilder: SchemaBuilderPort) {
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
 * the App method's request DTO. `get_naming_lexicon` is the one loose
 * schema (bd tea-rags-mcp-89k7k.1.15): unknown keys reach its handler, which
 * reads only the DTO fields.
 */
interface CodegraphToolDef {
  name: string;
  title: string;
  description: string;
  schemaKey: keyof CodegraphSchemas;
  invoke: (app: App, request: unknown) => Promise<McpToolResult>;
  /** Rows the response budget guard trims (bd tea-rags-mcp-c01gm); absent = the answer is a verdict, never cut. */
  responseRows?: ResponseRowsPolicy;
}

/**
 * The report's rows are its per-detector violation groups. `offset` skips the
 * same count in EVERY detector, so the guard caps every group at one count and
 * the continuation pages the held judgement by `reportId` — a group-order or
 * largest-first cut would leave a tail no single offset reaches without overlap.
 */
const ARCHITECTURE_REPORT_ROWS: ResponseRowsPolicy = {
  rows: ["violations.*"],
  continuation: offsetContinuation(["reportId"]),
  narrowing: ["detectors", "limit", "evidenceLimit", "pathPattern"],
};

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
      "Entries with origin:'model' come from residual resolution: probabilistic (carry model, p), not compiler truth. " +
      "File scope: pass relativePath instead of symbolId → {relativePath, importers[], total} — " +
      "files that import it, each {relativePath, importText, callWeight, modelCallWeight?, origin?}, heaviest callWeight first; origin:'model' = only a model call links them; " +
      `unknown file → empty importers + message. ${EMPTY_GRAPH_ANSWER_CONTRACT}`,
    schemaKey: "get_callers",
    responseRows: { narrowing: ["limit", "includeAmbiguous"] },
    invoke: async (app, request) => formatMcpResponse(await app.getCallers(request as GetCallersRequest)),
  },
  {
    name: "get_callees",
    title: "Get Callees",
    description:
      `Return symbols invoked by given symbolId. Backed by codegraph DuckDB. ${RESOLVED_SYMBOL_ID_CONTRACT}` +
      "Each callee carries the target's declared visibility (private|protected|public; absent = unknown). " +
      "Entries with origin:'model' come from residual resolution: probabilistic (carry model, p), not compiler truth. " +
      "File scope: pass relativePath instead of symbolId → {relativePath, imports[], total} — " +
      "files it imports, each {relativePath, importText, callWeight, modelCallWeight?, origin?}, heaviest callWeight first; origin:'model' = only a model call links them; " +
      `unknown file → empty imports + message. ${EMPTY_GRAPH_ANSWER_CONTRACT}`,
    schemaKey: "get_callees",
    responseRows: { narrowing: ["limit"] },
    invoke: async (app, request) => formatMcpResponse(await app.getCallees(request as GetCalleesRequest)),
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
      "the cycle was not recomputed since the index upgrade. hasModelEdge:true + modelEdgeCount = " +
      "hops inside the cycle only residual-model edges support (absent = all static).",
    schemaKey: "find_cycles",
    responseRows: { narrowing: ["scope", "pathPattern"] },
    invoke: async (app, request) => formatMcpResponse(await app.findCycles(request as FindCyclesRequest)),
  },
  {
    name: "get_architecture_report",
    title: "Get Architecture Report",
    // Answer-reading prose (tiers, cost, per-detector evidence) lives in
    // tea-rags://guide/architecture (bd tea-rags-mcp-0y5oj); this keeps the call contract.
    description:
      "Architecture diagnostics: is code laid out correctly (NOT is it risky to touch — use risk-assessment). " +
      "Typed violations per detector, one table each, tiered then costliest-first; evidence cut to evidenceLimit, " +
      "drillDown = ready follow-up call. Modes, one per call: report (default; options layerMap, norms, " +
      "domain = judge a directory AS ITS OWN SYSTEM) | knotOf | plannedEdges = judge edges before writing | " +
      "restructure = what-if delta | restructurePlan = ordered plan. Page via reportId + limit/offset. " +
      "Read tea-rags://guide/architecture to interpret the answer.",
    schemaKey: "get_architecture_report",
    responseRows: ARCHITECTURE_REPORT_ROWS,
    invoke: async (app, request) => {
      const req = request as GetArchitectureReportRequest;
      const answer = req.restructurePlan
        ? await app.planArchitectureRestructure(req)
        : req.restructure
          ? await app.simulateArchitectureRestructure(req)
          : req.plannedEdges
            ? await app.judgePlannedArchitectureEdges(req)
            : await app.getArchitectureReport(req);
      return formatMcpResponse(answer);
    },
  },
  {
    name: "get_ontology_report",
    title: "Get Ontology Report",
    description:
      "Project-wide naming ontology audit from the codegraph. synonyms: one type, many names; " +
      "homonyms: one name, many types; outliers: names off their type's dominant shape; " +
      "collisions: names equal to other symbols. Ranked, with counts and an example each.",
    schemaKey: "get_ontology_report",
    responseRows: { narrowing: ["sections", "limit", "pathPattern", "language"] },
    invoke: async (app, request) => formatMcpResponse(await app.getOntologyReport(request as GetOntologyReportRequest)),
  },
  {
    name: "find_co_changed",
    title: "Find Co-Changed Files",
    description:
      "File co-change partners from git history (cg_temporal sub-graph). Ranked by Wilson lower-bound strength; " +
      "each partner carries support, both directed confidences (pPartnerGivenFile, pFileGivenPartner), lift, " +
      "sample commits, structurallyLinked — an import/method/barrel edge joins the pair, false = silent coupling. " +
      "Provenance echoes head, window and build cuts; partners deleted from the working tree are dropped. " +
      "built:false = no co-change build yet (run a codegraph enrichment), NEVER read it as 'no partners'; " +
      "carries empty {reason:notBuilt}. files[].empty {reason:noHistory} = file shares no commit in window. " +
      "Before editing a file, surface silent high-strength partners as change-context.",
    schemaKey: "find_co_changed",
    responseRows: { narrowing: ["files", "limit"] },
    invoke: async (app, request) => formatMcpResponse(await app.findCoChanged(request as FindCoChangedRequest)),
  },
  {
    name: "trace_path",
    title: "Trace Path",
    description:
      "Trace all simple call paths from one symbol to another, in execution order. " +
      "Lean path enumeration by default. Pass `rerank` danger preset to annotate each step " +
      "with git/churn overlay and sort paths most-dangerous first. Steps carry declared visibility " +
      "when known (absent = unknown). Residual-model edges are walked and marked: a step reached by a " +
      "model-only hop carries origin:'model', model, p; such a path carries minP (its weakest p). " +
      "Backed by codegraph DuckDB. " +
      "from/to: host-class id with no node of its own → traced via the member's first definer up " +
      "hierarchy in MRO order; resolvedEndpoints names the id traced.",
    schemaKey: "trace_path",
    responseRows: { narrowing: ["maxPaths", "maxDepth", "fromPath", "toPath"] },
    // `TracePathRequest.rerank` is the string preset name the curated enum
    // (z.ZodTypeAny erases to unknown after .optional()) narrows to.
    invoke: async (app, request) => formatMcpResponse(await app.tracePath(request as TracePathRequest)),
  },
  {
    name: "get_naming_lexicon",
    title: "Get Naming Lexicon",
    description: NAMING_LEXICON_DESCRIPTION,
    schemaKey: "get_naming_lexicon",
    invoke: async (app, request) => formatMcpResponse(await app.getNamingLexicon(request as NamingLexiconRequest)),
  },
];

export function registerCodegraphTools(
  server: McpServer,
  deps: { app: App; schemaBuilder: SchemaBuilderPort; register: RegisterToolFn },
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
        ...(tool.responseRows && { responseRows: tool.responseRows }),
      },
      async (request: unknown) => tool.invoke(app, request),
    );
  }
}
