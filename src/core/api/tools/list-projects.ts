/**
 * Project Registry tools registration — thin wrappers delegating to App.
 *
 * Exposes the project registry stored at $TEA_RAGS_DATA_DIR/registry.json
 * to MCP clients.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { App } from "../public/index.js";
import { formatMcpResponse } from "./format.js";
import type { RegisterToolFn } from "./middleware/error-handler.js";

export function registerProjectTools(server: McpServer, deps: { app: App; register: RegisterToolFn }): void {
  const { app, register: registerToolSafe } = deps;

  // list_projects
  registerToolSafe(
    server,
    "list_projects",
    {
      title: "List Projects",
      description:
        "Registered projects from registry.json. Default: compact rows — name, path, collectionName, chunksCount, indexedAt, codegraphEnabled, worktreeOf. With project: that one full record (embedding, Qdrant, env, language versions); unknown alias → empty.suggestions.",
      inputSchema: {
        project: z.string().optional().describe("Alias → full record of that project only. Omit → compact list."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ project }) => {
      const result = await app.getProjectListing(project === undefined ? {} : { project });
      return formatMcpResponse(result);
    },
  );
}
