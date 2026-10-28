import type { WorkingTreeState } from "./working-tree.js";

/**
 * A find_symbol batch is not `cat` (bd tea-rags-mcp-yz10n): a file entry
 * answers its outline, and only a file of at most this many lines its full
 * text. One constant for the drill and the tool prose that states it.
 */
export const BATCH_FULL_TEXT_MAX_LINES = 60;

/**
 * A find_symbol batch address (agent turn economy N1) no symbol answered: the
 * address as requested, why, and — when the working tree deleted the file the
 * index holds it in — `treeState: "deleted"`.
 */
export interface SymbolBatchMiss {
  request: string;
  message: string;
  treeState?: WorkingTreeState;
  /**
   * An unknown PATH entry: the nearest indexed paths, as `empty.suggestions` of
   * `relativePath:` carries them. An unknown SYMBOL: the members of its
   * container when that resolves, else same-named ids, closest namespace first.
   * An AMBIGUOUS address: its candidates as `<symbolId> (<relativePath>)`,
   * class / module chunks first.
   */
  suggestions?: string[];
}
