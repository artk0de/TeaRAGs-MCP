/**
 * Codegraph MCP tools — slice 1: get_callers, get_callees.
 * Slice 2 adds: find_cycles.
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

import { PROJECT_NAME_RE, type App } from "../../core/api/public/index.js";
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
        "[RECOMMENDED] Project alias from registry — stable name that survives " +
          "path moves. Use this when an alias exists; fall back to 'collection' or " +
          "'path' only when no alias is registered. " +
          "Resolution priority: collection > project > path.",
      ),
    collection: z
      .string()
      .optional()
      .describe(
        "Internal Qdrant collection name (lowest-level handle). " +
          "Prefer 'project' when an alias is registered; provide one of 'project', 'collection', or 'path'.",
      ),
    path: z
      .string()
      .optional()
      .describe(
        "Filesystem path to indexed codebase (auto-resolves to a collection). " +
          "Prefer 'project' when an alias is registered; provide one of 'project', 'collection', or 'path'.",
      ),
  };
}

const GetCallersInputShape = {
  ...collectionPathFields(),
  symbolId: z.string().describe("Target symbol id (e.g. Foo.bar)"),
  limit: z.number().int().positive().max(500).optional().describe("Maximum number of caller edges (default 50)"),
};

const GetCalleesInputShape = {
  ...collectionPathFields(),
  symbolId: z.string().describe("Source symbol id (e.g. main)"),
  limit: z.number().int().positive().max(500).optional().describe("Maximum number of callee edges (default 50)"),
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
      "Picomatch glob scoping the result to a subdomain/module (e.g. '**/domains/ingest/**', " +
        "'{src/core/api,src/mcp}/**'). A cycle is kept if AT LEAST ONE member resolves to a matching " +
        "file path, so cross-boundary cycles are retained. Omit for no filter.",
    ),
};

export function registerCodegraphTools(server: McpServer, deps: { app: App; register: RegisterToolFn }): void {
  const { app, register: registerToolSafe } = deps;

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
      description: "Return symbols that invoke the given symbolId. Backed by the codegraph DuckDB.",
      inputSchema: GetCallersInputShape,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ project, collection, path, symbolId, limit }) => {
      const response = await app.getCallers({ project, collection, path, symbolId, limit });
      return formatMcpText(JSON.stringify(response, null, 2));
    },
  );

  registerToolSafe(
    server,
    "get_callees",
    {
      title: "Get Callees",
      description: "Return symbols invoked by the given symbolId. Backed by the codegraph DuckDB.",
      inputSchema: GetCalleesInputShape,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ project, collection, path, symbolId, limit }) => {
      const response = await app.getCallees({ project, collection, path, symbolId, limit });
      return formatMcpText(JSON.stringify(response, null, 2));
    },
  );

  registerToolSafe(
    server,
    "find_cycles",
    {
      title: "Find Cycles",
      description:
        "Return strongly-connected components (cycles) from the import or call graph. " +
        "Cycles of length >= 2; single-node 'cycles' are excluded. Read from a pre-computed " +
        "table — sub-millisecond per call.",
      inputSchema: FindCyclesInputShape,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ project, collection, path, scope, pathPattern }) => {
      const response = await app.findCycles({ project, collection, path, scope, pathPattern });
      return formatMcpText(JSON.stringify(response, null, 2));
    },
  );
}
