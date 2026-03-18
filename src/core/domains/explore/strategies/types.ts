/**
 * Explore strategy types — shared interface for all explore execution strategies.
 *
 * Strategies encapsulate the business logic of how an explore operation is executed
 * (vector, hybrid, scroll-rank) while keeping the MCP layer thin.
 */

import type { RankingOverlay } from "../../../contracts/types/reranker.js";

export interface ExploreContext {
  collectionName: string;
  query?: string;
  embedding?: number[];
  sparseVector?: { indices: number[]; values: number[] };
  limit: number;
  filter?: Record<string, unknown>;
  weights?: Record<string, number>;
  level?: "chunk" | "file";
  presetName?: string;
  offset?: number;
  pathPattern?: string;
  rerank?: unknown; // RerankMode<string> — unknown to avoid circular deps
  metaOnly?: boolean;
}

export interface ExploreResult<P = Record<string, unknown>> {
  id?: string | number;
  score: number;
  payload?: P;
  rankingOverlay?: RankingOverlay;
}

export interface ExploreStrategy {
  readonly type: "vector" | "hybrid" | "scroll-rank" | "similar";
  execute: (ctx: ExploreContext) => Promise<ExploreResult[]>;
}

// Re-export typed error for backward compatibility
export { HybridNotEnabledError } from "../errors.js";
