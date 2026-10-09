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
import { WORKING_TREE_PATH_HINT } from "./schemas.js";

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
    path: z.string().optional().describe(WORKING_TREE_PATH_HINT),
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
      "Role-pair norms: response.norms + violations for edges against their role pair's established " +
        "direction (MISFIT).",
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
  "MISFIT{suggestion}|NEW_TERM{topTerms}|NO_CONVENTION{prefer}|COLLISION,+alternatives,borderline,genericName; " +
  "`concept`+`language`→terms.";

/** Diff-review params `get_naming_lexicon` dropped when `review_changes` took them over (bd tea-rags-mcp-89k7k). */
const REMOVED_NAMING_LEXICON_DIFF_PARAMS = ["changes", "files"] as const;

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
      "Each detector's violations (shotgunSurgery excepted) ranked costliest-first BEFORE limit by maintenanceCost. File cost = " +
      "churn*(1+bugFix+recency)/3, each signal = file's position in collection's own git.file distribution " +
      "(commitCount, bugFixRate, ageDays inverted); costPosition = cost's mid-rank among all files. Carriers = files " +
      "on the edges that make the violation (named files; all file edges of a component edge or knot cut; hub's " +
      "boundary files; zone-of-pain's depended-on files; island/uselessness = all its files). score 0-1 = " +
      "carriers' meanPosition shrunk to 0.5 by n/(n+n0), n = measured carriers, n0 = (1/12)/between-violation " +
      "variance over the whole report, measured around the null mean 0.5 (empirical Bayes; all 0.5 when means sit no further from 0.5 than noise) — few " +
      "carriers pulled to 0.5, many keep their mean, comparable across families; hottestFile = costliest carrier with raw readings; absent = no git readings, " +
      "detector order kept. " +
      "stableDependencies (Stable Dependencies Principle): stable COMPONENT depending on less stable one — " +
      "component = module with measured facade, else directory; evidence = instabilities, Ca/Ce, delta, carrying " +
      "file edges; dependency on nested component not judged; rootCauses by unstable target component, " +
      "cycleWithDependents = target depends on own dependents. leakingAbstraction: " +
      "import past a module facade (index.ts/__init__.py/mod.rs) its importers adopted (>=3 importers, " +
      "adoption >0.5 and >= adaptive cut (Otsu when adoptions split bimodally, else the floor; summary gives threshold, method, separability); kind " +
      "bypass = facade re-exports what import takes (by imported names when indexed, else target file), " +
      "internal-reach = it does not (nonExportedNames), conventionPrivacy = Python _name " +
      "used from other package or Ruby send(:private) from outside its class; rootCauses per module. " +
      "silentCoupling: file pair co-changing strongly in git history with no import/re-export/resolved call " +
      "between them (support, P(B|A), P(A|B), lift, strength = Wilson lower bound, sample commits, " +
      "structuralVisibility); a pair is judged only when it beats the configuration null n_p*n_q*Qs/M^2 " +
      "(Poisson tail, BH q=0.05 over all pairs of files changed in >=2 bundles; summary.silentCoupling." +
      "cochangeSignificance, excluded.notSignificant) — hub files (locales, version manifests) die there; " +
      "strong = >0.5 and >= adaptive cut (Otsu when strengths split bimodally, else the floor); rootCauses = file with >=2 silent " +
      "partners; violations: pairs sharing an endpoint list as ONE kind:group finding (greedy, most pairs first) — " +
      "partners[] = every pair (support, expectedSupport = null λ, strength), evidence.topPartners = 3 strongest, " +
      "evidence.drillDown = ready find_co_changed call; limit caps findings, violationCount stays pairs, " +
      "groupedFindingCount = findings; summary.silentCoupling.built false = no co-change build, not clean. splitMerge: component " +
      "partition vs history over same sub-graph — splitCandidate = one component whose stored internal pairs " +
      "cluster >=2 groups, largestWeightShare < 0.7 (cohesion's cut), files = per-cluster exemplars (<=8); " +
      "mergeCandidate = two components whose admitted bundles overlap (support = bundles touching both, " +
      "changesA/B = bundles touching each, strength = Wilson lower bound of support/changes, same " +
      ">0.5 + Otsu cut, ONE draw over internal-pair and component-pair strengths); excluded counts " +
      "unpartitionedEndpoints / crossComponentPairs; summary.splitMerge.built false = no co-change build or " +
      "no persisted bundle membership (pre-042 index), not clean. shotgunSurgery: " +
      "one change (author burst) spanning >=k components (k = Otsu over burst widths, >=3), recurring beyond a " +
      "component-level configuration null (fitted inclusion propensity, Poisson tail, BH q=0.05), components in >=2 " +
      "structural islands (no dependency, specific shared neighbour, or feature subtree of <= T changed components); " +
      "commits whose per-file (added, deleted) counts repeat beyond chance (mechanical sweep, BH) are left out of the " +
      "history; a revert or flag removal mirroring an earlier commit's per-file net lines (permutation test, BH) joins " +
      "it as one change; a later commit retiring exactly lines an earlier one added (net -x for +x on shared files; " +
      "null = max(corpus revisit rate, file's own rate), Poisson-binomial, BH) joins it too; evidence support, " +
      "expectedSupport, strength (cohesion, not severity), familyEvidence = -log10 p - log10 C(n2,m) (list order; cost " +
      "tags only), islands, exemplarFiles, drillDown = find_co_changed; summary mechanicalCommitCount / " +
      "echoPairCount / lifecyclePairCount absent = line counts or commit timestamps not recorded; built false = same " +
      "reasons as splitMerge. mainSequence " +
      "(Stable Abstractions Principle): component far from A+I=1 — pain = stable+concrete, uselessness = " +
      "unstable+abstract; A from walker type census, D > max(0.5, Otsu cut); components whose language " +
      "rarely declares abstractions excluded (unobservableAbstractness); census needs codegraph recompute; pain " +
      "also needs volatility (mean git.file.commitCount per file > max(median file, log-scale Otsu cut)), calm ones " +
      "counted as stableConcreteCalm; evidence entryPoint:true = declared cli/mcp entry surface — its distance is " +
      "placement, not defect (triage data, never suppression). hubLikeDependency: component with BOTH Ca and Ce " +
      "above adaptive cuts (per axis: > median and >= log-scale Otsu cut when bimodal; Ca+Ce floor as SDP) AND " +
      "balanced (|Ca-Ce|/(Ca+Ce) < 1/4, Arcan; lopsided = excluded.imbalanced) — I near 0.5, so SDP misses it; evidence = top dependents/dependencies, transitiveImpact (components reaching it), " +
      "churn (mean git.file.commitCount), compositionRoot:true = triage data. summary.propagationCost (aggregate, " +
      "no violations; MacCormack DSM): reachable file pairs / N^2 = mean share of the system one change reaches; " +
      "corePeriphery classes files by visibility fan-in/out cuts (Otsu, else median) — core = high both AND in a " +
      "cycle, shared = in only, control = out only; shape = indeterminate when either cut fell back to the median " +
      "(no evidence of a split either way), else corePeriphery when core > 0, else hierarchical; " +
      "components (top limit by meanReach) carry internal propagationCost. layering: inferred layers without a declared architecture — SCC-condensed " +
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
      "down, never into summary.layering.foundation = abstractness-1 L0 components); summary.layering: coverage, levelCount, coherence (rank correlation level vs instability). layerMap " +
      "option: also return the map VIEW — levels per node in scopePathPattern (file|directory granularity, directoryDepth " +
      "collapse), boundary edges with the outside component's global level, move candidates; absent unless asked. domain " +
      "option: judge one directory AS ITS OWN SYSTEM (induced sub-graph, every metric recomputed inside — unlike " +
      "pathPattern which filters findings only); response.domain carries its layering counts + border edges naming the " +
      "external component and its whole-graph level. norms " +
      "option: the project's own dependency precedents per (roleSrc, roleDst, locality) from primary-type roles, one " +
      "ledger per language family (cross-family edges unjudged) — " +
      "norms violations flag MISFIT edges: against their role pair's established direction (exact sign test of " +
      "n(A->B) vs n(B->A), BH q=0.05 over the pairs; evidence = both counts, p, established direction). Summary " +
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
