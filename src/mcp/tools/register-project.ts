/**
 * Project registry tool registration — thin wrapper delegating to App.
 *
 * register_project associates a short alias with an absolute project path in
 * ~/.tea-rags/registry.json. The alias can then be passed as `project` to any
 * project-aware MCP tool instead of `path` or `collection`.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { App } from "../../core/api/index.js";
import { PROJECT_NAME_RE } from "../../core/infra/registry/index.js";
import { formatMcpResponse } from "../format.js";
import type { RegisterToolFn } from "../middleware/error-handler.js";

const RegisterProjectSchema = {
  path: z.string().min(1).describe("Absolute path to project root"),
  name: z
    .string()
    .regex(PROJECT_NAME_RE, `Project name must match ${PROJECT_NAME_RE.source}`)
    .describe("Short alias to register for this project (lowercase, digits, '-', '_'; max 64 chars)"),
};

export function registerRegisterProjectTool(server: McpServer, deps: { app: App; register: RegisterToolFn }): void {
  const { app, register: registerToolSafe } = deps;

  registerToolSafe(
    server,
    "register_project",
    {
      title: "Register Project",
      description:
        "Register a short alias for a project path. The alias is persisted in ~/.tea-rags/registry.json " +
        "and can be passed as 'project' to any project-aware MCP tool (search, indexing, metrics) " +
        "instead of 'path' or 'collection'. Returns the resolved collection name and whether the " +
        "underlying collection already contains indexed chunks.",
      inputSchema: RegisterProjectSchema,
      annotations: { idempotentHint: true },
    },
    async ({ path, name }) => {
      const result = await app.registerProject({ path, name });
      return formatMcpResponse(result);
    },
  );
}
