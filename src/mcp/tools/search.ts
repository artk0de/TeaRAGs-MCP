/**
 * Search tools registration
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { EmbeddingProvider } from "../../core/adapters/embeddings/base.js";
import { BM25SparseVectorGenerator } from "../../core/adapters/embeddings/sparse.js";
import type { QdrantManager } from "../../core/adapters/qdrant/client.js";
import {
  applyPostProcessing,
  formatSearchResults,
  getSearchFetchLimit,
  resolveCollectionName,
  validateCollectionExists,
} from "./formatters/search-pipeline.js";
import * as schemas from "./schemas.js";

export interface SearchToolDependencies {
  qdrant: QdrantManager;
  embeddings: EmbeddingProvider;
}

export function registerSearchTools(server: McpServer, deps: SearchToolDependencies): void {
  const { qdrant, embeddings } = deps;

  // semantic_search
  server.registerTool(
    "semantic_search",
    {
      title: "Semantic Search",
      description:
        "Search for documents using natural language queries. Returns the most semantically similar documents.",
      inputSchema: schemas.SemanticSearchSchema,
    },
    async ({ collection, path, query, limit, filter, pathPattern, rerank, metaOnly }) => {
      const resolved = resolveCollectionName(collection, path);
      if ("error" in resolved) return resolved.error;

      const collectionError = await validateCollectionExists(qdrant, resolved.collectionName, path);
      if (collectionError) return collectionError;

      const { embedding } = await embeddings.embed(query);
      const limits = getSearchFetchLimit(limit, pathPattern, rerank);
      const results = await qdrant.search(resolved.collectionName, embedding, limits.fetchLimit, filter);
      const processed = applyPostProcessing(results, { pathPattern, rerank, limit: limits.requestedLimit });

      return formatSearchResults(processed, metaOnly);
    },
  );

  // hybrid_search
  server.registerTool(
    "hybrid_search",
    {
      title: "Hybrid Search",
      description:
        "Perform hybrid search combining semantic vector search with keyword search using BM25. This provides better results by combining the strengths of both approaches. The collection must be created with enableHybrid set to true.",
      inputSchema: schemas.HybridSearchSchema,
    },
    async ({ collection, path, query, limit, filter, pathPattern, rerank, metaOnly }) => {
      const resolved = resolveCollectionName(collection, path);
      if ("error" in resolved) return resolved.error;

      const collectionError = await validateCollectionExists(qdrant, resolved.collectionName, path);
      if (collectionError) return collectionError;

      // Check hybrid support
      const collectionInfo = await qdrant.getCollectionInfo(resolved.collectionName);
      if (!collectionInfo.hybridEnabled) {
        return {
          content: [
            {
              type: "text",
              text: `Error: Collection "${resolved.collectionName}" does not have hybrid search enabled. Create a new collection with enableHybrid set to true.`,
            },
          ],
          isError: true,
        };
      }

      const { embedding } = await embeddings.embed(query);
      const sparseGenerator = new BM25SparseVectorGenerator();
      const sparseVector = sparseGenerator.generate(query);
      const limits = getSearchFetchLimit(limit, pathPattern, rerank);
      const results = await qdrant.hybridSearch(
        resolved.collectionName, embedding, sparseVector, limits.fetchLimit, filter,
      );
      const processed = applyPostProcessing(results, { pathPattern, rerank, limit: limits.requestedLimit });

      return formatSearchResults(processed, metaOnly);
    },
  );
}
