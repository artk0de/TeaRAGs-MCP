// Copyright (c) 2026 Arthur Korochansky
// SPDX-License-Identifier: MIT

/**
 * Tool registration orchestrator
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { App, McpAutoUpdateTrigger, SchemaBuilderPort } from "../public/index.js";
import { registerCodeTools } from "./code.js";
import { registerCodegraphTools } from "./codegraph.js";
import { registerCollectionTools } from "./collection.js";
import { registerDocumentTools } from "./document.js";
import { registerSearchTools } from "./explore.js";
import { registerProjectTools } from "./list-projects.js";
import { registerLocateTool } from "./locate/index.js";
import { createRegisterTool, type HealthProbes } from "./middleware/error-handler.js";
import { registerRegisterProjectTool } from "./register-project.js";
import { registerReviewChangesTool } from "./review-changes.js";
import { registerUnregisterProjectTool } from "./unregister-project.js";

export interface ToolDependencies {
  app: App;
  schemaBuilder: SchemaBuilderPort;
  healthProbes?: HealthProbes;
  /** Auto-update trigger for search tools (hpg2); absent = feature inert. */
  autoUpdate?: McpAutoUpdateTrigger;
  /** Register the hidden experimental `locate` tool; absent/false = not registered. */
  experimentalLocate?: boolean;
}

/**
 * Register all MCP tools on the server.
 * When healthProbes provided, all tools get health-aware error handling.
 */
export function registerAllTools(server: McpServer, deps: ToolDependencies): void {
  const register = createRegisterTool(deps.healthProbes);
  registerCollectionTools(server, { app: deps.app, register });
  registerDocumentTools(server, { app: deps.app, register });
  registerSearchTools(server, {
    app: deps.app,
    schemaBuilder: deps.schemaBuilder,
    register,
    ...(deps.autoUpdate !== undefined ? { autoUpdate: deps.autoUpdate } : {}),
  });
  registerCodeTools(server, { app: deps.app, schemaBuilder: deps.schemaBuilder, register });
  registerCodegraphTools(server, { app: deps.app, schemaBuilder: deps.schemaBuilder, register });
  registerReviewChangesTool(server, { app: deps.app, register });
  // EXPERIMENTAL, hidden: `locate` was measured ineffective in the 2026-10-27
  // spike (Codex TD-93238). Absent from tools/list unless bootstrap passes
  // `experimentalLocate` (EXPERIMENTAL_LOCATE_ENABLE). Not covered by plugin guidance.
  if (deps.experimentalLocate === true) registerLocateTool(server, { app: deps.app, register });
  registerProjectTools(server, { app: deps.app, register });
  registerRegisterProjectTool(server, { app: deps.app, register });
  registerUnregisterProjectTool(server, { app: deps.app, register });
}

// Re-export schemas for external use
export * from "./schemas.js";
