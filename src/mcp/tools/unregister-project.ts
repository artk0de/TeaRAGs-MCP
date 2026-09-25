/**
 * Project registry — unregister_project tool registration.
 *
 * Thin wrapper delegating to App.unregisterProject. Idempotent: returns
 * { removed: false } when the project was not registered. Does not touch the
 * Qdrant collection.
 *
 * Addressable by `name` OR `path` (exactly one — the op rejects both and
 * neither with typed errors). `path` exists because `index_codebase` on a bare
 * path registers the project WITHOUT a name (bd tea-rags-mcp-usbb5).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { App } from "../../core/api/public/index.js";
import { formatMcpResponse } from "../format.js";
import type { RegisterToolFn } from "../middleware/error-handler.js";

export const UnregisterProjectSchema = {
  name: z.string().min(1).optional().describe("Project name to remove from registry. Exactly one of name / path."),
  path: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Project root it was registered at; reaches projects indexed without a name. Exactly one of name / path.",
    ),
};

export function registerUnregisterProjectTool(server: McpServer, deps: { app: App; register: RegisterToolFn }): void {
  const { app, register: registerToolSafe } = deps;

  registerToolSafe(
    server,
    "unregister_project",
    {
      title: "Unregister Project",
      description:
        "Remove project from local registry by name or by path (exactly one). Idempotent: returns removed=false if project not registered. Does NOT delete Qdrant collection.",
      inputSchema: UnregisterProjectSchema,
      annotations: { destructiveHint: true },
    },
    async ({ name, path }) => {
      const result = await app.unregisterProject({
        ...(name !== undefined ? { name } : {}),
        ...(path !== undefined ? { path } : {}),
      });
      return formatMcpResponse(result);
    },
  );
}
