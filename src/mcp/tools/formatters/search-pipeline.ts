// src/mcp/tools/formatters/search-pipeline.ts
import { calculateFetchLimit, filterResultsByGlob } from "../../../core/adapters/qdrant/filters/index.js";
import { resolveCollectionName as resolveCollectionNameFromPath } from "../../../core/contracts/collection.js";
import type { RankingOverlay } from "../../../core/contracts/types/reranker.js";
import type { Reranker, RerankMode } from "../../../core/search/reranker.js";
import { BASE_PAYLOAD_SIGNALS } from "../../../core/trajectory/static/payload-signals.js";

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

function hasOverlayData(overlay: RankingOverlay): boolean {
  return Boolean(
    (overlay.file && Object.keys(overlay.file).length > 0) ||
    (overlay.chunk && Object.keys(overlay.chunk).length > 0) ||
    (overlay.derived && Object.keys(overlay.derived).length > 0),
  );
}

function buildGitFromOverlay(overlay: RankingOverlay): Record<string, unknown> {
  const git: Record<string, unknown> = {};
  if (overlay.file && Object.keys(overlay.file).length > 0) git.file = overlay.file;
  if (overlay.chunk && Object.keys(overlay.chunk).length > 0) git.chunk = overlay.chunk;
  return git;
}

function filterGitByEssential(
  fullGit: Record<string, Record<string, unknown>>,
  essentialKeys: string[],
): Record<string, unknown> {
  const git: Record<string, unknown> = {};
  for (const level of ["file", "chunk"] as const) {
    const levelData = fullGit[level];
    if (!levelData) continue;
    const filtered: Record<string, unknown> = {};
    for (const key of essentialKeys) {
      // key format: "git.file.ageDays" → extract level + field
      const parts = key.split(".");
      if (parts.length === 3 && parts[0] === "git" && parts[1] === level) {
        const field = parts[2];
        if (levelData[field] !== undefined) {
          filtered[field] = levelData[field];
        }
      }
    }
    if (Object.keys(filtered).length > 0) git[level] = filtered;
  }
  return git;
}

export function formatSearchResults(
  results: SearchResult[],
  metaOnly?: boolean,
  essentialTrajectoryFields?: string[],
): ToolResult {
  if (metaOnly) {
    const metaResults = results.map((r) => {
      const meta: Record<string, unknown> = { score: r.score };
      for (const signal of BASE_PAYLOAD_SIGNALS) {
        if (r.payload?.[signal.key] !== undefined) {
          meta[signal.key] = r.payload[signal.key];
        }
      }

      const overlay = (r as SearchResult & { rankingOverlay?: RankingOverlay }).rankingOverlay;
      const fullGit = r.payload?.git as Record<string, Record<string, unknown>> | undefined;

      if (overlay && hasOverlayData(overlay)) {
        // Rerank with mask: use overlay data as git
        const gitFromOverlay = buildGitFromOverlay(overlay);
        if (Object.keys(gitFromOverlay).length > 0) meta.git = gitFromOverlay;
        if (overlay.derived && Object.keys(overlay.derived).length > 0) meta.derived = overlay.derived;
        meta.preset = overlay.preset;
      } else if (fullGit) {
        // No overlay or empty overlay: filter to essential fields
        const filtered = filterGitByEssential(fullGit, essentialTrajectoryFields ?? []);
        if (Object.keys(filtered).length > 0) meta.git = filtered;
        if (overlay?.preset) meta.preset = overlay.preset;
      }
      // rankingOverlay intentionally excluded

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
