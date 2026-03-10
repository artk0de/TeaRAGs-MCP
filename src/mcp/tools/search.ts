/**
 * Search tools registration
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { EmbeddingProvider } from "../../core/adapters/embeddings/base.js";
import type { QdrantManager } from "../../core/adapters/qdrant/client.js";
import { filterResultsByGlob } from "../../core/adapters/qdrant/filters/index.js";
import { scrollOrderedBy } from "../../core/adapters/qdrant/scroll.js";
import { BM25SparseVectorGenerator } from "../../core/adapters/qdrant/sparse.js";
import type { SchemaBuilder } from "../../core/api/schema-builder.js";
import type { SchemaDriftMonitor } from "../../core/api/schema-drift-monitor.js";
import { RankModule } from "../../core/explore/rank-module.js";
import type { Reranker } from "../../core/explore/reranker.js";
import {
  applyPostProcessing,
  formatSearchResults,
  getSearchFetchLimit,
  resolveCollectionName,
  validateCollectionExists,
} from "./formatters/search-pipeline.js";
import { createSearchSchemas } from "./schemas.js";

export interface SearchToolDependencies {
  qdrant: QdrantManager;
  embeddings: EmbeddingProvider;
  reranker: Reranker;
  schemaBuilder: SchemaBuilder;
  essentialTrajectoryFields: string[];
  schemaDriftMonitor: SchemaDriftMonitor;
}

function appendDriftWarning(
  result: { content: { type: "text"; text: string }[]; [key: string]: unknown },
  driftWarning: string | null,
): typeof result {
  if (!driftWarning || result.content.length === 0) return result;
  const last = result.content[result.content.length - 1];
  last.text += `\n\n${driftWarning}`;
  return result;
}

export function registerSearchTools(server: McpServer, deps: SearchToolDependencies): void {
  const { qdrant, embeddings, schemaDriftMonitor } = deps;
  const searchSchemas = createSearchSchemas(deps.schemaBuilder);

  // semantic_search
  server.registerTool(
    "semantic_search",
    {
      title: "Semantic Search",
      description:
        "Search for documents using natural language queries. Returns the most semantically similar documents.",
      inputSchema: searchSchemas.SemanticSearchSchema,
    },
    async ({ collection, path, query, limit, filter, pathPattern, rerank, metaOnly }) => {
      const resolved = resolveCollectionName(collection, path);
      if ("error" in resolved) return resolved.error;

      const collectionError = await validateCollectionExists(qdrant, resolved.collectionName, path);
      if (collectionError) return collectionError;

      const { embedding } = await embeddings.embed(query);
      const limits = getSearchFetchLimit(limit, pathPattern, rerank);
      const results = await qdrant.search(resolved.collectionName, embedding, limits.fetchLimit, filter);
      const processed = applyPostProcessing(results, {
        pathPattern,
        rerank,
        limit: limits.requestedLimit,
        reranker: deps.reranker,
      });

      const result = formatSearchResults(processed, metaOnly, deps.essentialTrajectoryFields);
      const driftWarning = path
        ? await schemaDriftMonitor.checkAndConsume(path)
        : schemaDriftMonitor.checkByCollectionName(resolved.collectionName);
      return appendDriftWarning(result, driftWarning);
    },
  );

  // hybrid_search
  server.registerTool(
    "hybrid_search",
    {
      title: "Hybrid Search",
      description:
        "Perform hybrid search combining semantic vector search with keyword search using BM25. This provides better results by combining the strengths of both approaches. The collection must be created with enableHybrid set to true.",
      inputSchema: searchSchemas.HybridSearchSchema,
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
        resolved.collectionName,
        embedding,
        sparseVector,
        limits.fetchLimit,
        filter,
      );
      const processed = applyPostProcessing(results, {
        pathPattern,
        rerank,
        limit: limits.requestedLimit,
        reranker: deps.reranker,
      });

      const result = formatSearchResults(processed, metaOnly, deps.essentialTrajectoryFields);
      const driftWarning = path
        ? await schemaDriftMonitor.checkAndConsume(path)
        : schemaDriftMonitor.checkByCollectionName(resolved.collectionName);
      return appendDriftWarning(result, driftWarning);
    },
  );

  // rank_chunks
  const rankModule = new RankModule(deps.reranker, deps.reranker.getDescriptors());

  server.registerTool(
    "rank_chunks",
    {
      title: "Rank Chunks",
      description:
        "Rank all chunks in a collection by rerank signals without vector search. " +
        "Use for: finding decomposition candidates, tech debt analysis, hotspot detection, " +
        "ownership reports — any analysis where you need top-N chunks by signal, not by query similarity.",
      inputSchema: searchSchemas.RankChunksSchema,
    },
    async ({ collection, path, rerank, level, limit, offset, filter, pathPattern, metaOnly }) => {
      const resolved = resolveCollectionName(collection, path);
      if ("error" in resolved) return resolved.error;

      const collectionError = await validateCollectionExists(qdrant, resolved.collectionName, path);
      if (collectionError) return collectionError;

      // Resolve weights from preset or custom
      let sourceWeights: Record<string, number | undefined>;
      if (typeof rerank === "string") {
        const preset = deps.reranker.getPreset(rerank, "rank_chunks");
        if (!preset) {
          return {
            content: [{ type: "text", text: `Error: Unknown preset "${rerank}" for rank_chunks.` }],
            isError: true,
          };
        }
        sourceWeights = preset;
      } else {
        sourceWeights = rerank.custom;
      }
      const weights: Record<string, number> = Object.fromEntries(
        Object.entries(sourceWeights).filter((e): e is [string, number] => typeof e[1] === "number"),
      );

      const scrollFn = async (
        col: string,
        orderBy: { key: string; direction: "asc" | "desc" },
        lim: number,
        f?: Record<string, unknown>,
      ) => scrollOrderedBy(qdrant, col, orderBy, lim, f);

      const ensureIndexFn = async (col: string, fieldName: string) => {
        // Determine field type: git fields with counts/days are integer, others are float
        const isInteger = /count|days|lines/i.test(fieldName);
        await qdrant.ensurePayloadIndex(col, fieldName, isInteger ? "integer" : "float");
      };

      try {
        const effectiveOffset = offset || 0;
        const fetchLimit = (limit || 10) + effectiveOffset;

        // Exclude documentation from reranked results
        const effectiveFilter = excludeDocumentation(filter);

        let results = await rankModule.rankChunks(resolved.collectionName, {
          weights,
          level,
          limit: fetchLimit,
          scrollFn,
          ensureIndexFn,
          filter: effectiveFilter,
          presetName: typeof rerank === "string" ? rerank : undefined,
        });

        // Apply pathPattern client-side
        if (pathPattern) {
          results = filterResultsByGlob(results as never, pathPattern);
        }

        // Apply offset
        if (effectiveOffset > 0) {
          results = results.slice(effectiveOffset);
        }

        const result = formatSearchResults(results as never, metaOnly, deps.essentialTrajectoryFields);
        const driftWarning = path
          ? await schemaDriftMonitor.checkAndConsume(path)
          : schemaDriftMonitor.checkByCollectionName(resolved.collectionName);
        return appendDriftWarning(result, driftWarning);
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Error in rank_chunks: ${msg}` }],
          isError: true,
        };
      }
    },
  );
}

/**
 * Exclude documentation chunks from reranked results using must_not.
 * Uses must_not because code chunks don't have isDocumentation field at all —
 * Qdrant can't match {value: false} on a missing field.
 */
function excludeDocumentation(filter?: Record<string, unknown>): Record<string, unknown> {
  const docExclusion = { key: "isDocumentation", match: { value: true } };
  if (!filter) {
    return { must_not: [docExclusion] };
  }
  const existing = filter.must_not;
  const mustNot = Array.isArray(existing) ? [...(existing as Record<string, unknown>[]), docExclusion] : [docExclusion];
  return { ...filter, must_not: mustNot };
}
