/**
 * Collection management tools registration — thin wrappers delegating to App.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { App } from "../../core/api/app.js";
import { formatMcpError, formatMcpResponse, formatMcpText } from "../format.js";
import * as schemas from "./schemas.js";

export function registerCollectionTools(server: McpServer, deps: { app: App }): void {
  const { app } = deps;

  // create_collection
  server.registerTool(
    "create_collection",
    {
      title: "Create Collection",
      description:
        "Create a new vector collection in Qdrant. The collection will be configured with the embedding provider's dimensions automatically. Set enableHybrid to true to enable hybrid search combining semantic and keyword search.",
      inputSchema: schemas.CreateCollectionSchema,
    },
    async ({ name, distance, enableHybrid }) => {
      try {
        const info = await app.createCollection({ name, distance, enableHybrid });
        let message = `Collection "${info.name}" created successfully with ${info.vectorSize} dimensions and ${info.distance} distance metric.`;
        if (info.hybridEnabled) {
          message += " Hybrid search is enabled for this collection.";
        }
        return formatMcpText(message);
      } catch (error) {
        return formatMcpError(error instanceof Error ? error.message : String(error));
      }
    },
  );

  // list_collections
  server.registerTool(
    "list_collections",
    {
      title: "List Collections",
      description: "List all available collections in Qdrant.",
      inputSchema: {},
    },
    async () => {
      try {
        const collections = await app.listCollections();
        return formatMcpResponse(collections);
      } catch (error) {
        return formatMcpError(error instanceof Error ? error.message : String(error));
      }
    },
  );

  // get_collection_info
  server.registerTool(
    "get_collection_info",
    {
      title: "Get Collection Info",
      description:
        "Get detailed information about a collection including vector size, point count, and distance metric.",
      inputSchema: schemas.GetCollectionInfoSchema,
    },
    async ({ name }) => {
      try {
        const info = await app.getCollectionInfo(name);
        return formatMcpResponse(info);
      } catch (error) {
        return formatMcpError(error instanceof Error ? error.message : String(error));
      }
    },
  );

  // delete_collection
  server.registerTool(
    "delete_collection",
    {
      title: "Delete Collection",
      description: "Delete a collection and all its documents.",
      inputSchema: schemas.DeleteCollectionSchema,
    },
    async ({ name }) => {
      try {
        await app.deleteCollection(name);
        return formatMcpText(`Collection "${name}" deleted successfully.`);
      } catch (error) {
        return formatMcpError(error instanceof Error ? error.message : String(error));
      }
    },
  );
}
