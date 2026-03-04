// src/mcp/tools/formatters/search-pipeline.ts
import { calculateFetchLimit, filterResultsByGlob } from "../../../core/adapters/qdrant/filters/index.js";
import { resolveCollectionName as resolveCollectionNameFromPath } from "../../../core/contracts/collection.js";
import { BASE_PAYLOAD_SIGNALS } from "../../../core/contracts/payload-signals.js";
import type { Reranker, RerankMode } from "../../../core/search/reranker.js";

interface SearchResult {
  id: string | number;
  score: number;
  payload?: Record<string, unknown>;
}

interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  [key: string]: unknown;
}

export function resolveCollectionName(
  collection?: string,
  path?: string,
): { collectionName: string } | { error: ToolResult } {
  if (!collection && !path) {
    return {
      error: {
        content: [{ type: "text", text: "Error: Either 'collection' or 'path' parameter is required." }],
        isError: true,
      },
    };
  }
  return { collectionName: collection || resolveCollectionNameFromPath(path ?? "") };
}

export function getSearchFetchLimit(
  requestedLimit: number | undefined,
  pathPattern?: string,
  rerank?: unknown,
): { requestedLimit: number; fetchLimit: number } {
  const limit = requestedLimit || 5;
  const needsOverfetch = Boolean(pathPattern) || Boolean(rerank && rerank !== "relevance");
  return { requestedLimit: limit, fetchLimit: calculateFetchLimit(limit, needsOverfetch) };
}

export function applyPostProcessing(
  results: SearchResult[],
  options: { pathPattern?: string; rerank?: unknown; limit: number; reranker: Reranker },
): SearchResult[] {
  let filtered = options.pathPattern ? filterResultsByGlob(results, options.pathPattern) : results;

  if (options.rerank && options.rerank !== "relevance") {
    filtered = options.reranker.rerank(filtered, options.rerank as RerankMode<string>, "semantic_search");
  }

  return filtered.slice(0, options.limit);
}

export function formatSearchResults(results: SearchResult[], metaOnly?: boolean): ToolResult {
  if (metaOnly) {
    const metaResults = results.map((r) => {
      const meta: Record<string, unknown> = { score: r.score };
      for (const signal of BASE_PAYLOAD_SIGNALS) {
        if (r.payload?.[signal.key] !== undefined) {
          meta[signal.key] = r.payload[signal.key];
        }
      }
      if (r.payload?.git) meta.git = r.payload.git;
      if ((r as SearchResult & { rankingOverlay?: unknown }).rankingOverlay) {
        meta.rankingOverlay = (r as SearchResult & { rankingOverlay?: unknown }).rankingOverlay;
      }
      return meta;
    });
    return { content: [{ type: "text", text: JSON.stringify(metaResults, null, 2) }] };
  }

  return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
}

export async function validateCollectionExists(
  qdrant: { collectionExists: (name: string) => Promise<boolean> },
  collectionName: string,
  path?: string,
): Promise<ToolResult | null> {
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
  return null;
}
