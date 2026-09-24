/**
 * Codegraph resolve rate — the miss definition and the rendering rule, each
 * written once for every producer (`summarizeCodegraphResolve`) and renderer
 * (`tea-rags prime` `## Codegraph resolve`, `scripts/codegraph-chain-tally.ts`
 * `--kind-stats`).
 *
 * The rate is `resolved / (resolved + resolveRateMiss)`. Its denominator is
 * empty when every attempted site fell into an excluded bucket — a new
 * language's receiver kind whose every member has no in-project def is the
 * typical case. That is "nothing to score", which is not a number: rendering it
 * as 1.000 reads as "resolved everything", as 0.000 as "resolved nothing of
 * what it tried" (bd tea-rags-mcp-qodqg).
 */

/** Counters a resolve-rate denominator is derived from. */
export interface ResolveRateCounts {
  attempted: number;
  resolved: number;
  externalSkipped: number;
  unresolvable: number;
  noInProjectDef: number;
  coreAmbiguous: number;
}

/**
 * Genuine recall holes: attempted misses minus every bucket that can never
 * become an in-project edge — external-library targets (ykj7), dynamic sends
 * (cai0), members with no in-project def (cai0.2), and core homonyms on an
 * untyped receiver (83cl7). `ambiguousFanout` is deliberately NOT subtracted:
 * the strict rate keeps an over-cap fan in the denominator. The single place
 * the exclusion list is written.
 */
export function resolveRateMiss(t: ResolveRateCounts): number {
  return Math.max(
    0,
    t.attempted - t.resolved - t.externalSkipped - t.unresolvable - t.noInProjectDef - t.coreAmbiguous,
  );
}

/** What an empty-denominator rate renders as — a marker, never a number. */
export const EMPTY_RESOLVE_DENOMINATOR_MARKER = "—";

/**
 * A bare rate with no counters beside it — prime's default `resolve rate:`
 * line, the per-language capability row, the run-end stderr diagnostic. `null`
 * (nothing scored) renders the marker; a scored 0 renders as a number (bd
 * tea-rags-mcp-stpvj).
 */
export function formatResolveRate(rate: number | null, renderRate: (rate: number) => string): string {
  return rate === null ? EMPTY_RESOLVE_DENOMINATOR_MARKER : renderRate(rate);
}

/** One `rate counters` cell of a resolve-rate row. */
export interface ResolveRateCell {
  /**
   * The rate to render when the denominator is non-empty; ignored otherwise.
   * `null` is the DTO's empty-denominator value and always renders the marker.
   */
  rate: number | null;
  /** `resolved + resolveRateMiss` — zero means nothing was scored. */
  denominator: number;
  /** The row's counters (e.g. `0/6`), rendered in both cases. */
  counters: string;
  /** The renderer's number format (`toFixed(3)`, two-decimal rounding, ...). */
  renderRate: (rate: number) => string;
}

/**
 * `0.960 125/130` when anything was scored, `—  0/0` when the denominator is
 * empty — the counters stay so the reader still sees what was attempted.
 */
export function formatResolveRateCell(cell: ResolveRateCell): string {
  if (cell.denominator === 0 || cell.rate === null) return `${EMPTY_RESOLVE_DENOMINATOR_MARKER}  ${cell.counters}`;
  return `${cell.renderRate(cell.rate)} ${cell.counters}`;
}
