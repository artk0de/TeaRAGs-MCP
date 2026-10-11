/**
 * Search result rows (bd tea-rags-mcp-g7w8f). `ExploreResult` is the row the
 * explore strategies, the working-tree floors and the chunk groupers pass
 * between them; `SearchResult` is the row the public search DTOs carry. Both
 * live in contracts because the explore domain produces them and may import
 * neither the api layer that names the response (`api/public/dto/explore.ts`
 * re-exports `SearchResult`) nor a sibling sub-module above the one consuming
 * the row (`domains/explore/strategies/types.ts` re-exports `ExploreResult`).
 */

import type { RankingOverlay } from "./reranker.js";
import type { WorkingTreeState } from "./working-tree.js";

/** One explore row as the strategies, floors and groupers exchange it. */
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

/** One search row as the public search responses carry it. */
export interface SearchResult {
  id: string | number;
  score: number;
  payload?: Record<string, unknown>;
  rankingOverlay?: RankingOverlay;
  /**
   * The working tree changed (`modified`) or deleted (`deleted`) this row's
   * file and the tool has no floor to answer from the tree (bd
   * tea-rags-mcp-xi2r9.3). Absent on rows the tree did not touch.
   */
  treeState?: WorkingTreeState;
}
