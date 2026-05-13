/**
 * Project registry — unregister_project tool registration.
 *
 * Thin wrapper delegating to App.unregisterProject. Idempotent: returns
 * { removed: false } when the project was not registered. Does not touch the
 * Qdrant collection.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { App } from "../../core/api/index.js";
import { formatMcpResponse } from "../format.js";
import type { RegisterToolFn } from "../middleware/error-handler.js";

export const UnregisterProjectSchema = {
  name: z.string().min(1).describe("Project name to remove from the registry"),
};

export function registerUnregisterProjectTool(server: McpServer, deps: { app: App; register: RegisterToolFn }): void {
  const { app, register: registerToolSafe } = deps;

  registerToolSafe(
    server,
    "unregister_project",
    {
      title: "Unregister Project",
      description:
        "Remove a project from the local registry by name. Idempotent: returns removed=false if the project was not registered. Does not delete the Qdrant collection.",
      inputSchema: UnregisterProjectSchema,
      annotations: { destructiveHint: true },
    },
    async ({ name }) => {
      const result = await app.unregisterProject({ name });
      return formatMcpResponse(result);
    },
  );
}
