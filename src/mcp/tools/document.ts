/**
 * Document operation tools registration — thin wrappers delegating to App.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { App } from "../../core/api/app.js";
import { formatMcpError, formatMcpText } from "../format.js";
import * as schemas from "./schemas.js";

export function registerDocumentTools(server: McpServer, deps: { app: App }): void {
  const { app } = deps;

  // add_documents
  server.registerTool(
    "add_documents",
    {
      title: "Add Documents",
      description:
        "Add documents to a collection. Documents will be automatically embedded using the configured embedding provider.",
      inputSchema: schemas.AddDocumentsSchema,
    },
    async ({ collection, documents }) => {
      try {
        const result = await app.addDocuments({ collection, documents });
        return formatMcpText(`Successfully added ${result.count} document(s) to collection "${collection}".`);
      } catch (error) {
        return formatMcpError(error instanceof Error ? error.message : String(error));
      }
    },
  );

  // delete_documents
  server.registerTool(
    "delete_documents",
    {
      title: "Delete Documents",
      description: "Delete specific documents from a collection by their IDs.",
      inputSchema: schemas.DeleteDocumentsSchema,
    },
    async ({ collection, ids }) => {
      try {
        const result = await app.deleteDocuments({ collection, ids });
        return formatMcpText(`Successfully deleted ${result.count} document(s) from collection "${collection}".`);
      } catch (error) {
        return formatMcpError(error instanceof Error ? error.message : String(error));
      }
    },
  );
}
