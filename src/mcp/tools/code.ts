/**
 * Code indexing tools registration — orchestrator delegating to per-family modules.
 *
 * Families:
 * - index: index_codebase, reindex_changes (build/update lifecycle)
 * - status: get_index_status, get_index_metrics (inspection)
 * - maintenance: clear_index (destructive)
 * - search: search_code (query)
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { App, SchemaBuilder } from "../../core/api/index.js";
import type { RegisterToolFn } from "../middleware/error-handler.js";
import { registerIndexTools } from "./code/register-index-tools.js";
import { registerMaintenanceTools } from "./code/register-maintenance-tools.js";
import { registerSearchTools } from "./code/register-search-tools.js";
import { registerStatusTools } from "./code/register-status-tools.js";

export function registerCodeTools(
  server: McpServer,
  deps: { app: App; schemaBuilder: SchemaBuilder; register: RegisterToolFn },
): void {
  registerIndexTools(server, { app: deps.app, register: deps.register });
  registerStatusTools(server, { app: deps.app, register: deps.register });
  registerMaintenanceTools(server, { app: deps.app, register: deps.register });
  registerSearchTools(server, deps);
}
