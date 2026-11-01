import type { WorkingTreeState } from "./working-tree.js";

/**
 * A find_symbol file answers its full text up to this many lines (bd
 * tea-rags-mcp-03yel) — `relativePath:` and a `symbols` batch path entry
 * alike. One constant for the strategy and the tool prose that states it.
 */
export const FULL_TEXT_MAX_LINES = 150;

/**
 * A find_symbol file over {@link FULL_TEXT_MAX_LINES} still answers its full
 * text while it stays within this many chars (bd tea-rags-mcp-d0z7b.3) — the
 * line rule alone outlined 151–200-line files no bigger than a 150-line one.
 * Measured on a Rails app (app+lib) / tea-rags src: ≤150-line files p95 4.7k /
 * 6.0k chars, the 101–150 band p95 6.3k / 7.1k; the 151–200 band p50 6.2k /
 * 7.4k, p90 8.2k / 9.0k. At 9k the union admits 46% / 28% of the >150-line
 * files (7.1% / 9.3% of all); offline replay of a real thread: −3.0k net chars,
 * −1 request. A union, not a char-only rule: a pure 9k cap would outline files
 * that are full text today.
 */
export const FULL_TEXT_MAX_CHARS = 9_000;

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
 * Internal payload key holding a container row's header draft (bd: one
 * inlined-text budget per answer): whatever re-renders the row under a smaller
 * answer allowance reads it, and `stripInternalFields` drops it before an
 * answer leaves the core.
 */
export const CONTAINER_HEADER_DRAFT_KEY = "containerHeaderDraft";

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

/**
 * A find_symbol method row carries `referencedDefinitions` (bd
 * tea-rags-mcp-d0z7b.4): the statements defining the class-level constants its
 * body names, read from its owner's header chunks. Their text stays within this
 * many chars per row; a definition past it is named by id and lines only.
 * Measured on a Rails corpus (30,955 methods): 8.7% of method rows reference a
 * same-class constant, adding p50 62 / p90 274 / p99 1,652 chars (max 51k), so
 * 800 holds ~p95 whole and clips the tail.
 */
export const REFERENCED_DEFINITIONS_ROW_CHAR_CAP = 800;

/**
 * The summed `referencedDefinitions` text of one find_symbol answer (single
 * symbol or batch), charged against {@link BATCH_FULL_TEXT_CHAR_BUDGET} as
 * well; a definition past either is named by id and lines only.
 */
export const REFERENCED_DEFINITIONS_CHAR_BUDGET = 2_000;
