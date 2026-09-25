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

import { PROJECT_NAME_RE, type App, type SchemaBuilder } from "../../core/api/public/index.js";
import { formatMcpText } from "../format.js";
import type { RegisterToolFn } from "../middleware/error-handler.js";

/**
 * Shared `{ collection, project, path }` triad for codegraph tools.
 * Mirrors `collectionPathFields()` in `mcp/tools/schemas.ts` and the
 * `SchemaBuilder.collectionIdentifier()` mixin — kept inline here
 * because the codegraph tool surface is independent of the dynamic
 * search-tool schema pipeline. Resolution priority: collection >
 * project > path.
 */
function collectionPathFields() {
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
      "Glob scoping judged edges by SOURCE file. Instability and adoption stay whole-graph. Omit for whole project.",
    ),
  limit: z
    .number()
    .int()
    .positive()
    .max(500)
    .optional()
    .describe("Max violations and max root causes per detector (default 50). Summary keeps totals."),
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

export function registerCodegraphTools(
  server: McpServer,
  deps: { app: App; schemaBuilder: SchemaBuilder; register: RegisterToolFn },
): void {
  const { app, schemaBuilder, register: registerToolSafe } = deps;

  // Provider gating — when codegraph.symbols isn't registered, none of these
  // tools should appear in the MCP `list_tools` response. Silent no-op
  // (no error, no log) — the upstream gate at composition is what controls
  // the surface.
  if (!app.hasProvider("codegraph.symbols")) return;

  registerToolSafe(
    server,
    "get_callers",
    {
      title: "Get Callers",
      description:
        "Return symbols that invoke given symbolId. Backed by codegraph DuckDB. " +
        "Top-level visibility = queried symbol's declared level; each caller carries its own " +
        "(private|protected|public; absent = unknown). " +
        "Pass includeAmbiguous:true to also list ambiguous dispatch sites (member-matched, " +
        "MAY reach target among candidateCount candidates; not materialized as edges). " +
        "File scope: pass relativePath instead of symbolId → {relativePath, importers[], total} — " +
        "files that import it, each {relativePath, importText, callWeight}, heaviest callWeight first; " +
        "unknown file → empty importers + message.",
      inputSchema: GetCallersInputShape,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ project, collection, path, symbolId, relativePath, limit, includeAmbiguous }) => {
      const response = await app.getCallers({
        project,
        collection,
        path,
        symbolId,
        relativePath,
        limit,
        includeAmbiguous,
      });
      return formatMcpText(JSON.stringify(response, null, 2));
    },
  );

  registerToolSafe(
    server,
    "get_callees",
    {
      title: "Get Callees",
      description:
        "Return symbols invoked by given symbolId. Backed by codegraph DuckDB. " +
        "Each callee carries the target's declared visibility (private|protected|public; absent = unknown). " +
        "File scope: pass relativePath instead of symbolId → {relativePath, imports[], total} — " +
        "files it imports, each {relativePath, importText, callWeight}, heaviest callWeight first; " +
        "unknown file → empty imports + message.",
      inputSchema: GetCalleesInputShape,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ project, collection, path, symbolId, relativePath, limit }) => {
      const response = await app.getCallees({ project, collection, path, symbolId, relativePath, limit });
      return formatMcpText(JSON.stringify(response, null, 2));
    },
  );

  registerToolSafe(
    server,
    "find_cycles",
    {
      title: "Find Cycles",
      description:
        "Return strongly-connected components (cycles) from import or call graph. " +
        "Cycles length >= 2; single-node 'cycles' excluded. Read from pre-computed " +
        "table — sub-millisecond per call. scope=method: members are symbol ids and " +
        "memberLocations lists {symbolId, relativePath} per member in the same order — " +
        "namesakes in different files are distinct members; an empty relativePath means " +
        "the cycle was not recomputed since the index upgrade.",
      inputSchema: FindCyclesInputShape,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ project, collection, path, scope, pathPattern }) => {
      const response = await app.findCycles({ project, collection, path, scope, pathPattern });
      return formatMcpText(JSON.stringify(response, null, 2));
    },
  );

  registerToolSafe(
    server,
    "get_architecture_report",
    {
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
        "used from other package or Ruby send(:private) from outside its class; rootCauses per module. Summary " +
        "counts exclusions with named reasons. Diagnosis, not prescription.",
      inputSchema: GetArchitectureReportInputShape,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ project, collection, path, pathPattern, limit }) => {
      const response = await app.getArchitectureReport({ project, collection, path, pathPattern, limit });
      return formatMcpText(JSON.stringify(response, null, 2));
    },
  );

  registerToolSafe(
    server,
    "trace_path",
    {
      title: "Trace Path",
      description:
        "Trace all simple call paths from one symbol to another, in execution order. " +
        "Lean path enumeration by default. Pass `rerank` danger preset to annotate each step " +
        "with git/churn overlay and sort paths most-dangerous first. Steps carry declared visibility " +
        "when known (absent = unknown). Backed by codegraph DuckDB.",
      inputSchema: buildTracePathInputShape(schemaBuilder),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ project, collection, path, from, to, fromPath, toPath, rerank, maxDepth, maxPaths }) => {
      // `rerank` is a curated preset enum (z.ZodTypeAny erases to unknown after
      // .optional()); narrow to the string preset name the DTO expects.
      const preset = rerank as string | undefined;
      const response = await app.tracePath({
        project,
        collection,
        path,
        from,
        to,
        fromPath,
        toPath,
        rerank: preset,
        maxDepth,
        maxPaths,
      });
      return formatMcpText(JSON.stringify(response, null, 2));
    },
  );
}
