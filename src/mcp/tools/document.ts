/**
 * Document operation tools registration — thin wrappers delegating to App.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { App } from "../../core/api/index.js";
import { formatMcpText } from "../format.js";
import type { RegisterToolFn } from "../middleware/error-handler.js";
import * as schemas from "./schemas.js";

export function registerDocumentTools(server: McpServer, deps: { app: App; register: RegisterToolFn }): void {
  const { app, register: registerToolSafe } = deps;

  // add_documents
  registerToolSafe(
    server,
    "add_documents",
    {
      title: "Add Documents",
      description:
        "Add documents to a collection. Documents will be automatically embedded using the configured embedding provider.",
      inputSchema: schemas.AddDocumentsSchema,
      annotations: {},
    },
    async ({ collection, documents }) => {
      const result = await app.addDocuments({ collection, documents });
      return formatMcpText(`Successfully added ${result.count} document(s) to collection "${collection}".`);
    },
  );

  // delete_documents
  registerToolSafe(
    server,
    "delete_documents",
    {
      title: "Delete Documents",
      description: "Delete specific documents from a collection by their IDs.",
      inputSchema: schemas.DeleteDocumentsSchema,
      annotations: { destructiveHint: true },
    },
    async ({ collection, ids }) => {
      const result = await app.deleteDocuments({ collection, ids });
      return formatMcpText(`Successfully deleted ${result.count} document(s) from collection "${collection}".`);
    },
  );
}
