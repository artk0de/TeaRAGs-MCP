/**
 * Codegraph residual resolution (wave 1) — the call sites the static resolver
 * leaves without an edge, the model edges a residual pass applies over them,
 * the verdicts it caches, and the provider port that answers them.
 *
 * Every port type lives here rather than in the residual domain: the verdict
 * store and the model-provider adapters implement or persist them, and adapters
 * import only `core/{contracts,infra}`. The domain's `residual/types.ts`
 * re-exports them. `ResidualPassReport` sits here too: the index status
 * carries the last pass's report.
 *
 * Spec: `docs/superpowers/specs/2026-10-09-codegraph-residual-resolution-design.md`
 */

export type ResidualKind = "ambiguous" | "dynamic";

/**
 * Why a language keeps a residual site out of `cg_residual_call_sites`: the true
 * callee is outside the menu, so no model pick can be right. `schemaColumn` — a
 * column accessor on a receiver named after the model owning it; `frameworkMember`
 * — a framework method on a receiver chain the framework itself returns.
 */
export type ResidualExclusionRule = "schemaColumn" | "frameworkMember";

/** One row of `cg_residual_call_sites` (053). */
export interface ResidualCallSiteRow {
  /** sha1(relPath, methodSymbolId, line, column, receiverText, member). */
  siteKey: string;
  sourceRelPath: string;
  methodSymbolId: string;
  methodStartLine: number;
  methodEndLine: number;
  line: number;
  column: number;
  receiverText: string;
  member: string;
  kind: ResidualKind;
  /** Target method symbolIds, e.g. `"Firm#users"`. */
  candidates: string[];
  /** sha1 of the sorted candidates joined by `"\n"`. */
  menuHash: string;
  /** The candidates were cut at the menu limit. */
  menuOverflow: boolean;
}

/** A model-picked edge for one residual site, written with `origin = 'model'` (054). */
export interface ModelEdgeRow {
  siteKey: string;
  sourceRelPath: string;
  /** The residual row's `methodSymbolId`. */
  sourceSymbolId: string;
  /** The picked candidate. */
  targetSymbolId: string;
  model: string;
  p: number;
}

/**
 * What `applyModelEdges` left in the graph. `stored` counts distinct model
 * edges (the method-edge key dedupes sites making the same call to the same
 * target; a key a static edge holds is not stored). `changed` is whether the
 * model's stored edges differ from what they were before the apply.
 */
export interface ModelEdgeApplyResult {
  stored: number;
  changed: boolean;
}

export type EdgeOrigin = "static" | "model";

export interface ResidualVerdict {
  siteKey: string;
  menuHash: string;
  model: string;
  modelVersion: string;
  pick: string;
  p: number;
  probabilities: Record<string, number>;
  questionPayload: string;
  /** Epoch ms. */
  createdAt: number;
  /** Epoch ms. */
  lastSeenAt: number;
}

export interface ResidualQuestion {
  siteKey: string;
  menuHash: string;
  receiverText: string;
  member: string;
  kind: ResidualKind;
  candidates: string[];
}

export interface ResidualQuestionGroup {
  sourceRelPath: string;
  methodSymbolId: string;
  methodSource: string;
  questions: ResidualQuestion[];
}

export interface ResidualAnswer {
  siteKey: string;
  pick: string;
  p: number;
  probabilities: Record<string, number>;
  questionPayload: string;
}

/** Exclusive use of the model's hardware for one pass; `release` never throws. */
export interface ResidualProviderLease {
  release: () => Promise<void>;
}

export interface ResidualModelProvider {
  readonly id: string;
  readonly threshold: number;
  version: () => Promise<string>;
  health: () => Promise<{ ok: true } | { ok: false; reason: string }>;
  /**
   * Takes the hardware before the first `resolveGroup`; absent = the model is
   * always up. Called only when a pass has questions to ask.
   */
  acquire?: () => Promise<ResidualProviderLease>;
  /** `signal` aborts when the pass stops asking; the provider then settles the request at once with a rejection. */
  resolveGroup: (group: ResidualQuestionGroup, signal?: AbortSignal) => Promise<ResidualAnswer[]>;
}

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
  /** Edge apply, derived-stale mark and recompute, touch and expire. */
  applyMs: number;
  /** The derived-metrics recompute alone; part of `applyMs`, 0 when the edges did not change. */
  recomputeMs: number;
  totalMs: number;
}

/**
 * The derived metrics (cycles, PageRank) after the pass: `unchanged` — the
 * model edges did not change, nothing to do; `recomputed`; `stale` — the
 * recompute failed and the tables stay marked stale for the next run.
 */
export type ResidualDerivedState = "unchanged" | "recomputed" | "stale";

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
  /** Rows neither asked nor applied: the menu has fewer entries than the floor (`CODEGRAPH_RESIDUAL_MIN_MENU`). */
  menuTooSmall: number;
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
  /** Groups in flight when the pass stopped asking; cancelled, not failed — their sites are asked next run. */
  abortedGroups: number;
  /** Groups that timed out and were asked once more at the tail of the queue; a second timeout is a failure. */
  requeuedGroups: number;
  /** Eligible rows whose verdict is under the provider threshold. */
  belowThreshold: number;
  /** Eligible rows whose verdict is at or above the provider threshold. */
  sitesEdged: number;
  /**
   * Distinct model edges stored. Until 2m83f.29 this counted sites (what
   * `sitesEdged` counts now); sites making the same call to the same target
   * share one edge.
   */
  edgesApplied: number;
  derived: ResidualDerivedState;
  durations: ResidualPassDurations;
}
