/**
 * Residual resolution port, domain side. The port types are declared in
 * contracts because adapters (`ResidualVerdictStore`, `KevResidualProvider`)
 * may import only `core/{contracts,infra}`; domain code reads them through this
 * re-export. `ResidualPassReport` is domain-only.
 */

export type {
  ResidualAnswer,
  ResidualModelProvider,
  ResidualProviderLease,
  ResidualQuestion,
  ResidualQuestionGroup,
  ResidualVerdict,
} from "../../../../contracts/types/codegraph-residual.js";

/**
 * `ask` queries the model for sites with no verdict at its served version;
 * `cacheOnly` makes no model call and re-applies the newest stored verdict per
 * current site (a static re-walk drops a file's model edges).
 */
export type ResidualPassMode = "ask" | "cacheOnly";

/** Wall time per stage, ms. */
export interface ResidualPassDurations {
  /** Health, version, site read and cache lookup. */
  readMs: number;
  askMs: number;
  /** Edge apply, derived-stale mark, touch and expire. */
  applyMs: number;
  totalMs: number;
}

/**
 * Counts are in sites (residual rows) unless named otherwise. `skipped` means
 * the model could not be asked as requested; edges are still applied from the
 * verdicts the pass holds.
 */
export interface ResidualPassReport {
  outcome: "completed" | "skipped";
  reason?: string;
  mode: ResidualPassMode;
  /** Every current residual row. */
  sites: number;
  /** Rows not asked: the menu overflowed or exceeds the menu limit. */
  menuOverflow: number;
  /** Eligible rows answered from the verdict store. */
  cacheHits: number;
  /** Methods holding at least one uncached question. */
  groups: number;
  /** Deduplicated questions sent to the model this run, failed groups included. */
  asked: number;
  /** Questions whose answer was stored as a verdict. */
  answered: number;
  /** Questions of groups the model refused as too long. */
  tooLong: number;
  failedGroups: number;
  /** Eligible rows whose verdict is under the provider threshold. */
  belowThreshold: number;
  edgesApplied: number;
  durations: ResidualPassDurations;
}
