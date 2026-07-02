/**
 * Project registry — unregister_project tool registration.
 *
 * Thin wrapper delegating to App.unregisterProject. Idempotent: returns
 * { removed: false } when the project was not registered. Does not touch the
 * Qdrant collection.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { App } from "../../core/api/public/index.js";
import { formatMcpResponse } from "../format.js";
import type { RegisterToolFn } from "../middleware/error-handler.js";

export const UnregisterProjectSchema = {
  name: z.string().min(1).describe("Project name remove from registry"),
};

export function registerUnregisterProjectTool(server: McpServer, deps: { app: App; register: RegisterToolFn }): void {
  const { app, register: registerToolSafe } = deps;

  registerToolSafe(
    server,
    "unregister_project",
    {
      title: "Unregister Project",
      description:
        "Remove project from local registry by name. Idempotent: returns removed=false if project not registered. Does NOT delete Qdrant collection.",
      inputSchema: UnregisterProjectSchema,
      annotations: { destructiveHint: true },
    },
    async ({ name }) => {
      const result = await app.unregisterProject({ name });
      return formatMcpResponse(result);
    },
  );
}
