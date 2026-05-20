/**
 * Codegraph MCP tools — slice 1: get_callers, get_callees.
 *
 * Both tools read directly from the codegraph DuckDB via the App's
 * GraphFacade (wired in createApp()). Slice 2 adds get_dependencies,
 * get_dependents, find_cycles.
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
}
