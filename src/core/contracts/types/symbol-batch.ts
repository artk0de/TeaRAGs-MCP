import type { WorkingTreeState } from "./working-tree.js";

/**
 * A find_symbol file answers its full text up to this many lines (bd
 * tea-rags-mcp-03yel) — `relativePath:` and a `symbols` batch path entry
 * alike. One constant for the strategy and the tool prose that states it.
 */
export const FULL_TEXT_MAX_LINES = 150;

/**
 * A find_symbol batch is not `cat` (bd tea-rags-mcp-yz10n): its path entries
 * answer full text, in request order, while their summed text stays within
 * this many chars; an entry past it answers its outline. Measured on files of
 * 61–150 lines (the band a 60-line cap outlined): median 3.3k (Rails app) /
 * 4.2k (tea-rags), 100–150 lines p90 6.3k / 6.7k — so the budget holds 4 such
 * files at p90, 5–7 at the median, and stays ≈57% of the 42k-char response
 * guard, leaving room for the batch's other rows.
 */
export const BATCH_FULL_TEXT_CHAR_BUDGET = 24_000;

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
