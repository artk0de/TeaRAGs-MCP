/**
 * Tool registration orchestrator
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { App } from "../../core/api/app.js";
import type { SchemaBuilder } from "../../core/api/schema-builder.js";
import { registerCodeTools } from "./code.js";
import { registerCollectionTools } from "./collection.js";
import { registerDocumentTools } from "./document.js";
import { registerSearchTools } from "./explore.js";

export interface ToolDependencies {
  app: App;
  schemaBuilder: SchemaBuilder;
}

/**
 * Register all MCP tools on the server
 */
export function registerAllTools(server: McpServer, deps: ToolDependencies): void {
  registerCollectionTools(server, { app: deps.app });
  registerDocumentTools(server, { app: deps.app });
  registerSearchTools(server, { app: deps.app, schemaBuilder: deps.schemaBuilder });
  registerCodeTools(server, { app: deps.app, schemaBuilder: deps.schemaBuilder });
}

// Re-export schemas for external use
export * from "./schemas.js";
