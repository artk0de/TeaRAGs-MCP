/**
 * Search tools registration
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { CodeIndexer } from "../code/indexer.js";
import { rerankSemanticSearchResults, type RerankMode, type SemanticSearchRerankPreset } from "../code/reranker.js";
import type { EmbeddingProvider } from "../embeddings/base.js";
import { BM25SparseVectorGenerator } from "../embeddings/sparse.js";
import type { QdrantManager } from "../qdrant/client.js";
import { calculateFetchLimit, filterResultsByGlob } from "../qdrant/filters/index.js";
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
      // Resolve collection name from path or use provided collection
      if (!collection && !path) {
        return {
          content: [
            {
              type: "text",
              text: "Error: Either 'collection' or 'path' parameter is required.",
            },
          ],
          isError: true,
        };
      }
      const collectionName = collection || CodeIndexer.resolveCollectionName(path!);

      // Check if collection exists
      const exists = await qdrant.collectionExists(collectionName);
      if (!exists) {
        return {
          content: [
            {
              type: "text",
              text: `Error: Collection "${collectionName}" does not exist.${path ? ` Codebase at "${path}" may not be indexed.` : ""}`,
            },
          ],
          isError: true,
        };
      }

      // Generate embedding for query
      const { embedding } = await embeddings.embed(query);

      // Calculate fetch limit (fetch more if we need to filter by glob or rerank)
      const requestedLimit = limit || 5;
      const needsOverfetch = Boolean(pathPattern) || Boolean(rerank && rerank !== "relevance");
      const fetchLimit = calculateFetchLimit(requestedLimit, needsOverfetch);

      // Search
      const results = await qdrant.search(collectionName, embedding, fetchLimit, filter);

      // Apply glob pattern filter if specified
      let filteredResults = pathPattern ? filterResultsByGlob(results, pathPattern) : results;

      // Apply reranking if specified
      if (rerank && rerank !== "relevance") {
        filteredResults = rerankSemanticSearchResults(
          filteredResults,
          rerank as RerankMode<SemanticSearchRerankPreset>,
        );
      }

      // Trim to requested limit
      filteredResults = filteredResults.slice(0, requestedLimit);

      // Format output based on metaOnly flag
      if (metaOnly) {
        const metaResults = filteredResults.map((r) => ({
          score: r.score,
          relativePath: r.payload?.relativePath,
          startLine: r.payload?.startLine,
          endLine: r.payload?.endLine,
          language: r.payload?.language,
          chunkType: r.payload?.chunkType,
          name: r.payload?.name,
          imports: r.payload?.imports,
          git: r.payload?.git,
        }));
        return {
          content: [{ type: "text", text: JSON.stringify(metaResults, null, 2) }],
        };
      }

      return {
        content: [{ type: "text", text: JSON.stringify(filteredResults, null, 2) }],
      };
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
      // Resolve collection name from path or use provided collection
      if (!collection && !path) {
        return {
          content: [
            {
              type: "text",
              text: "Error: Either 'collection' or 'path' parameter is required.",
            },
          ],
          isError: true,
        };
      }
      const collectionName = collection || CodeIndexer.resolveCollectionName(path!);

      // Check if collection exists
      const exists = await qdrant.collectionExists(collectionName);
      if (!exists) {
        return {
          content: [
            {
              type: "text",
              text: `Error: Collection "${collectionName}" does not exist.${path ? ` Codebase at "${path}" may not be indexed.` : ""}`,
            },
          ],
          isError: true,
        };
      }

      // Check if collection has hybrid search enabled
      const collectionInfo = await qdrant.getCollectionInfo(collectionName);
      if (!collectionInfo.hybridEnabled) {
        return {
          content: [
            {
              type: "text",
              text: `Error: Collection "${collectionName}" does not have hybrid search enabled. Create a new collection with enableHybrid set to true.`,
            },
          ],
          isError: true,
        };
      }

      // Generate dense embedding for query
      const { embedding } = await embeddings.embed(query);

      // Generate sparse vector for query
      const sparseGenerator = new BM25SparseVectorGenerator();
      const sparseVector = sparseGenerator.generate(query);

      // Calculate fetch limit (fetch more if we need to filter by glob or rerank)
      const requestedLimit = limit || 5;
      const needsOverfetch = Boolean(pathPattern) || Boolean(rerank && rerank !== "relevance");
      const fetchLimit = calculateFetchLimit(requestedLimit, needsOverfetch);

      // Perform hybrid search
      const results = await qdrant.hybridSearch(collectionName, embedding, sparseVector, fetchLimit, filter);

      // Apply glob pattern filter if specified
      let filteredResults = pathPattern ? filterResultsByGlob(results, pathPattern) : results;

      // Apply reranking if specified
      if (rerank && rerank !== "relevance") {
        filteredResults = rerankSemanticSearchResults(
          filteredResults,
          rerank as RerankMode<SemanticSearchRerankPreset>,
        );
      }

      // Trim to requested limit
      filteredResults = filteredResults.slice(0, requestedLimit);

      // Format output based on metaOnly flag
      if (metaOnly) {
        const metaResults = filteredResults.map((r) => ({
          score: r.score,
          relativePath: r.payload?.relativePath,
          startLine: r.payload?.startLine,
          endLine: r.payload?.endLine,
          language: r.payload?.language,
          chunkType: r.payload?.chunkType,
          name: r.payload?.name,
          imports: r.payload?.imports,
          git: r.payload?.git,
        }));
        return {
          content: [{ type: "text", text: JSON.stringify(metaResults, null, 2) }],
        };
      }

      return {
        content: [{ type: "text", text: JSON.stringify(filteredResults, null, 2) }],
      };
    },
  );
}
