// Copyright (c) 2025 Martin Halder <halderm@arkadia-labs.io>
// Copyright (c) 2026 Arthur Korochansky
// SPDX-License-Identifier: MIT

/**
 * Tool registration orchestrator
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { App, SchemaBuilder } from "../../core/api/public/index.js";
import { createRegisterTool, type HealthProbes } from "../middleware/error-handler.js";
import { registerCodeTools } from "./code.js";
import { registerCodegraphTools } from "./codegraph.js";
import { registerCollectionTools } from "./collection.js";
import { registerDocumentTools } from "./document.js";
import { registerSearchTools } from "./explore.js";
import { registerProjectTools } from "./list-projects.js";
import { registerRegisterProjectTool } from "./register-project.js";
import { registerUnregisterProjectTool } from "./unregister-project.js";

export interface ToolDependencies {
  app: App;
  schemaBuilder: SchemaBuilder;
  healthProbes?: HealthProbes;
}

/**
 * Register all MCP tools on the server.
 * When healthProbes provided, all tools get health-aware error handling.
 */
export function registerAllTools(server: McpServer, deps: ToolDependencies): void {
  const register = createRegisterTool(deps.healthProbes);
  registerCollectionTools(server, { app: deps.app, register });
  registerDocumentTools(server, { app: deps.app, register });
  registerSearchTools(server, { app: deps.app, schemaBuilder: deps.schemaBuilder, register });
  registerCodeTools(server, { app: deps.app, schemaBuilder: deps.schemaBuilder, register });
  registerCodegraphTools(server, { app: deps.app, register });
  registerProjectTools(server, { app: deps.app, register });
  registerRegisterProjectTool(server, { app: deps.app, register });
  registerUnregisterProjectTool(server, { app: deps.app, register });
}

// Re-export schemas for external use
export * from "./schemas.js";
