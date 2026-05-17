/**
 * Index maintenance tools: clear_index (destructive).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { App } from "../../../core/api/index.js";
import { formatMcpText } from "../../format.js";
import type { RegisterToolFn } from "../../middleware/error-handler.js";
import * as schemas from "../schemas.js";
import { resolvePathFromProject } from "./shared.js";

export function registerMaintenanceTools(server: McpServer, deps: { app: App; register: RegisterToolFn }): void {
  const { app, register: registerToolSafe } = deps;

  // clear_index
  registerToolSafe(
    server,
    "clear_index",
    {
      title: "Clear Index",
      description:
        "Delete all indexed data for a codebase. This is irreversible and will remove the entire collection.",
      inputSchema: schemas.ClearIndexSchema,
      annotations: { destructiveHint: true },
    },
    async ({ path: pathArg, project }) => {
      const path = await resolvePathFromProject({ path: pathArg, project }, app);
      await app.clearIndex(path);
      return formatMcpText(`Index cleared for codebase at "${path}".`);
    },
  );
}
