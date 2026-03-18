/**
 * Collection management tools registration — thin wrappers delegating to App.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { App } from "../../core/api/index.js";
import { formatMcpResponse, formatMcpText } from "../format.js";
import { registerToolSafe } from "../middleware/error-handler.js";
import * as schemas from "./schemas.js";

export function registerCollectionTools(server: McpServer, deps: { app: App }): void {
  const { app } = deps;

  // create_collection
  registerToolSafe(
    server,
    "create_collection",
    {
      title: "Create Collection",
      description:
        "Create a new vector collection in Qdrant. The collection will be configured with the embedding provider's dimensions automatically. Set enableHybrid to true to enable hybrid search combining semantic and keyword search.",
      inputSchema: schemas.CreateCollectionSchema,
      annotations: { idempotentHint: true },
    },
    async ({ name, distance, enableHybrid }) => {
      const info = await app.createCollection({ name, distance, enableHybrid });
      let message = `Collection "${info.name}" created successfully with ${info.vectorSize} dimensions and ${info.distance} distance metric.`;
      if (info.hybridEnabled) {
        message += " Hybrid search is enabled for this collection.";
      }
      return formatMcpText(message);
    },
  );

  // list_collections
  registerToolSafe(
    server,
    "list_collections",
    {
      title: "List Collections",
      description: "List all available collections in Qdrant.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const collections = await app.listCollections();
      return formatMcpResponse(collections);
    },
  );

  // get_collection_info
  registerToolSafe(
    server,
    "get_collection_info",
    {
      title: "Get Collection Info",
      description:
        "Get detailed information about a collection including vector size, point count, and distance metric.",
      inputSchema: schemas.GetCollectionInfoSchema,
      annotations: { readOnlyHint: true },
    },
    async ({ name }) => {
      const info = await app.getCollectionInfo(name);
      return formatMcpResponse(info);
    },
  );

  // delete_collection
  registerToolSafe(
    server,
    "delete_collection",
    {
      title: "Delete Collection",
      description: "Delete a collection and all its documents.",
      inputSchema: schemas.DeleteCollectionSchema,
      annotations: { destructiveHint: true },
    },
    async ({ name }) => {
      await app.deleteCollection(name);
      return formatMcpText(`Collection "${name}" deleted successfully.`);
    },
  );
}
