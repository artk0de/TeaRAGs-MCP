import type { WorkingTreeState } from "./working-tree.js";

/**
 * A find_symbol batch address (agent turn economy N1) no symbol answered: the
 * address as requested, why, and — when the working tree deleted the file the
 * index holds it in — `treeState: "deleted"`.
 */
export interface SymbolBatchMiss {
  request: string;
  message: string;
  treeState?: WorkingTreeState;
}
