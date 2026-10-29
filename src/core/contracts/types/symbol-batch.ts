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
 * A find_symbol container answer inlines its class-level header chunks — whole,
 * in line order — while their summed text stays within this many chars; a chunk
 * past it stays an address (its member ids answer it). Measured 2026-10-29 as
 * the per-class header total (every class-level chunk of the container in its
 * file): Rails corpus, 62 classes — p50 0.4k, p90 2.9k, p95 5.9k, p99 ≈ 9.8k,
 * max 25k (the `Firm` god model); tea-rags TS — p50 ≈ 0.13k per chunk, largest
 * class 5.6k. 6k inlines ~p95 of classes whole and is a quarter of
 * {@link BATCH_FULL_TEXT_CHAR_BUDGET}, the size of one 150-line file at p90.
 */
export const CONTAINER_HEADER_CHAR_BUDGET = 6_000;

/**
 * `payload.kind` of a find_symbol container row whose `content` carries header
 * code after its member outline — complete for its class-level part, an
 * outline for its methods. Absent when no header chunk was inlined.
 */
export const CONTAINER_HEADER_KIND = "containerHeader";

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
