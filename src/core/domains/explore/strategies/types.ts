/**
 * Explore strategy types — shared interface for all explore execution strategies.
 *
 * Strategies encapsulate the business logic of how an explore operation is executed
 * (vector, hybrid, scroll-rank) while keeping the MCP layer thin.
 */

import type { RankingOverlay } from "../../../contracts/types/reranker.js";
import type { WorkingTreeState } from "../../../contracts/types/working-tree.js";
import type { WorkingTreeView } from "../working-tree/overlay.js";

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
  /**
   * The tree this request reads (bd tea-rags-mcp-xi2r9). Floor strategies
   * substitute its re-read rows; the rest stamp `treeState` on base rows of
   * its files. Every strategy stamps rows of files it serves from the index
   * (`indexServedPaths`).
   */
  workingTreeView?: WorkingTreeView;
  /**
   * The query could not be embedded: the embedding provider is unreachable.
   * Set → a strategy that has a lexical leg (hybrid's BM25) ranks by it alone,
   * and `embedding` is absent. `reason` is the provider's error message.
   */
  denseUnavailable?: { reason: string };
  /**
   * The request's history clock, unix SECONDS (bd tea-rags-mcp-zwu7m): the
   * indexed commit's committer time for a head-anchored index, absent for the
   * wall clock. Resolved once by the read path; every rerank of the request
   * derives age / recency from it (`RerankOptions.now`).
   */
  historyAnchorSec?: number;
}

export interface ExploreResult<P = Record<string, unknown>> {
  id?: string | number;
  score: number;
  payload?: P;
  rankingOverlay?: RankingOverlay;
  /**
   * Set on a base row of a file the working tree changed or deleted, where no
   * floor replaced it — always on a row of an index-served file.
   */
  treeState?: WorkingTreeState;
}

export interface ExploreStrategy {
  readonly type: "vector" | "hybrid" | "scroll-rank" | "similar";
  execute: (ctx: ExploreContext) => Promise<ExploreResult[]>;
}

// Re-export typed error for backward compatibility
export { HybridNotEnabledError } from "../errors.js";
