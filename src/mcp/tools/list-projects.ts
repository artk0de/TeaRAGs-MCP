/**
 * Project Registry tools registration — thin wrappers delegating to App.
 *
 * Exposes the project registry stored at $TEA_RAGS_DATA_DIR/registry.json
 * to MCP clients.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { App } from "../../core/api/public/index.js";
import { formatMcpResponse } from "../format.js";
import type { RegisterToolFn } from "../middleware/error-handler.js";

export function registerProjectTools(server: McpServer, deps: { app: App; register: RegisterToolFn }): void {
  const { app, register: registerToolSafe } = deps;

  // list_projects
  registerToolSafe(
    server,
    "list_projects",
    {
      title: "List Projects",
      description:
        "List registered projects + collection metadata from $TEA_RAGS_DATA_DIR/registry.json. Per project returns: collection name, indexed path, embedding model + dimensions, Qdrant URL, indexedAt timestamp, tea-rags version, chunk count.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const result = await app.listProjects();
      return formatMcpResponse(result);
    },
  );
}
