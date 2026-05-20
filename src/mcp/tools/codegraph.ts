/**
 * Codegraph MCP tools — slice 1: get_callers, get_callees.
 * Slice 2 adds: find_cycles.
 *
 * All tools read directly from the codegraph DuckDB via the App's
 * GraphFacade (wired in createApp()).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { App } from "../../core/api/index.js";
import { formatMcpText } from "../format.js";
import type { RegisterToolFn } from "../middleware/error-handler.js";

const GetCallersInputShape = {
  path: z.string().describe("Project path"),
  symbolId: z.string().describe("Target symbol id (e.g. Foo.bar)"),
  limit: z.number().int().positive().max(500).optional().describe("Maximum number of caller edges (default 50)"),
};

const GetCalleesInputShape = {
  path: z.string().describe("Project path"),
  symbolId: z.string().describe("Source symbol id (e.g. main)"),
  limit: z.number().int().positive().max(500).optional().describe("Maximum number of callee edges (default 50)"),
};

const FindCyclesInputShape = {
  path: z.string().describe("Project path"),
  scope: z
    .enum(["file", "method"])
    .default("file")
    .describe("'file' = circular imports between files; 'method' = circular calls between symbols"),
};

export function registerCodegraphTools(server: McpServer, deps: { app: App; register: RegisterToolFn }): void {
  const { app, register: registerToolSafe } = deps;

  registerToolSafe(
    server,
    "get_callers",
    {
      title: "Get Callers",
      description: "Return symbols that invoke the given symbolId. Backed by the codegraph DuckDB.",
      inputSchema: GetCallersInputShape,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ path, symbolId, limit }) => {
      const response = await app.getCallers({ path, symbolId, limit });
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
    async ({ path, symbolId, limit }) => {
      const response = await app.getCallees({ path, symbolId, limit });
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
    async ({ path, scope }) => {
      const response = await app.findCycles({ path, scope });
      return formatMcpText(JSON.stringify(response, null, 2));
    },
  );
}
