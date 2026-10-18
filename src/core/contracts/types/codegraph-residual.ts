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
 * Why a residual row carries a narrowed menu (059). `frameworkOverride`: the
 * callee is a framework member, and the menu holds only the project overrides
 * the receiver can reach (bd tea-rags-mcp-2m83f.48).
 */
export type ResidualReason = "frameworkOverride";

/**
 * Why a language keeps a residual site out of `cg_residual_call_sites`: the true
 * callee is outside the menu, so no model pick can be right. `schemaColumn` — a
 * column accessor on a receiver named after the model owning it; `frameworkMember`
 * — a framework method on a receiver chain the framework itself returns;
 * `timestampColumn` — `created_at` / `updated_at` on a bare receiver when no model
 * declares a def of that name.
 */
export type ResidualExclusionRule = "schemaColumn" | "frameworkMember" | "timestampColumn";

/**
 * One class of a receiver group: the class, the target its member reaches there,
 * and that target's return type when known. A `null` target is a schema column
 * the class reads the member as — an answer with no method node to edge to; its
 * return type is the column's value type (bd tea-rags-mcp-2m83f.55).
 */
export type ResidualClassTarget = [className: string, targetSymbolId: string | null, returnType?: string];

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
  /** The `cg_run_stats` language the site was counted under (055 backfills it from the file row). */
  language?: string;
  /** The `cg_run_stats` receiver kind the site was counted under, e.g. `"ivar"` (055); absent on a row written before it. */
  receiverKind?: string;
  /**
   * sha1 of the site's receiver group (`receiverGroupKey`): every residual call on
   * one receiver in one method shares it, and the pass asks the group one class
   * question (061). Absent — the site is asked on its own `candidates`.
   */
  receiverGroup?: string;
  /**
   * The receiver group's narrowed class set, uncut, in menu order (naming prior,
   * then name), each class with the target it reaches this site's member through
   * — its own definition or the nearest ancestor's: `[["Invoice", "Invoice#save"],
   * ["Bill", "Document#save"]]` (061). Present with {@link receiverGroup}. A
   * third element is the class the target returns on that class, when the walk
   * knows it — `["Client", "Client#firm", "Firm"]` (bd 2m83f.51).
   */
  classTargets?: ResidualClassTarget[];
  /**
   * {@link receiverGroup} of the next hop whose receiver is this call
   * (`record.firm` for `record.firm.name`): an accepted class's return type is a
   * type fact on that group (bd 2m83f.51). Absent on a row whose call starts no
   * chain hop the walk saw as a group.
   */
  downstreamGroup?: string;
  /** Why the menu is narrowed (059); absent = the ordinary short-name menu. */
  reason?: ResidualReason;
}

/**
 * Residual sites a model edge resolves, per `cg_run_stats` bucket and model. A
 * site counts once, under the model of its most probable edge. `receiverKind` is
 * `null` for a row written before 055; `language` only when its file has no
 * `cg_symbols_files` row either.
 */
/** How the static resolver settled a sampled site. */
export type StaticSiteOutcome = "resolved" | "externalSkipped";

/**
 * A call site the static resolver settled, kept as calibration ground truth
 * (`cg_static_site_sample`): a resolved site's truth is the owner of
 * `targetSymbolId`, an external one's is "none of the menu".
 */
export interface StaticSiteSampleRow {
  siteKey: string;
  sourceRelPath: string;
  language: string;
  methodSymbolId: string;
  methodStartLine: number;
  methodEndLine: number;
  line: number;
  column: number;
  receiverText: string;
  receiverKind: string;
  member: string;
  outcome: StaticSiteOutcome;
  /** The resolved edge's target; `null` for an external site. */
  targetSymbolId: string | null;
  /** The miss bucket of an unresolved site; `null` when resolved. */
  reason: string | null;
  /** Project classes defining the member — the full menu size. */
  owners: number;
  /** The menu a residual question gets: every owner's method, or the name-matched block on overflow. */
  candidates: string[];
  menuOverflow: boolean;
  /** Hash priority in [0, 1): the sample's draw order. */
  priority: number;
}

export interface ModelResolvedSiteCount {
  /**
   * `edge` — a model edge resolves the site; `external` — the model put its target
   * outside the project (058); `attribute` — the model's class reads the member as
   * a schema column, which has no method node (064).
   */
  outcome: "edge" | "external" | "attribute";
  language: string | null;
  receiverKind: string | null;
  kind: ResidualKind;
  model: string;
  sites: number;
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

/**
 * A residual site the model answered "none of these — defined outside the
 * project" for, at or above `CODEGRAPH_RESIDUAL_NONE_THRESHOLD` (058). `menuHash`
 * is the residual row's: a re-walk that changes the menu un-counts it.
 */
export interface ModelExternalSiteRow {
  siteKey: string;
  sourceRelPath: string;
  menuHash: string;
  model: string;
  p: number;
  /** `attribute` — the picked class reads the member as a schema column (064); absent — outside the project. */
  outcome?: "attribute";
}

export type EdgeOrigin = "static" | "model";

/**
 * Shape of the question a residual model is asked. 2: every menu ends with a
 * "none of these" option and a verdict's `pick` may be null. 3: a receiver
 * group is asked once, its menu is classes (`subject: "class"`). Folded into
 * the verdict key, so a verdict given to another shape is never reused.
 */
export const RESIDUAL_QUESTION_VERSION = 3;

/**
 * Version of the code that turns a request into the model's state (method
 * source, window, origin section). Folded into the verdict key with the
 * provider's prompt template; bump it when the state a question is asked over
 * changes shape.
 */
export const RESIDUAL_STATE_BUILDER_VERSION = 1;

/** Key of the none option's probability in `ResidualVerdict.probabilities` — never a symbol id. */
export const RESIDUAL_NONE_PROBABILITY_KEY = "(none)";

export interface ResidualVerdict {
  siteKey: string;
  menuHash: string;
  model: string;
  modelVersion: string;
  /** Candidate symbolId; `null` — none of the menu, the target is outside the project. */
  pick: string | null;
  /** Probability of the pick, none included. */
  p: number;
  probabilities: Record<string, number>;
  questionPayload: string;
  /** Epoch ms. */
  createdAt: number;
  /** Epoch ms. */
  lastSeenAt: number;
}

export interface ResidualQuestion {
  /** The site's key; for a receiver-group question, the group's question key. */
  siteKey: string;
  menuHash: string;
  receiverText: string;
  member: string;
  kind: ResidualKind;
  /** Target method symbolIds; class names when `subject` is `"class"`. */
  candidates: string[];
  /** `"class"` — a receiver-group question: `candidates` are classes and the pick is one of them. */
  subject?: "class";
  /** Every member called on the receiver in the method, for a receiver-group question. */
  members?: string[];
}

export interface ResidualQuestionGroup {
  sourceRelPath: string;
  methodSymbolId: string;
  methodSource: string;
  questions: ResidualQuestion[];
}

export interface ResidualAnswer {
  siteKey: string;
  /** `null` — none of the menu. */
  pick: string | null;
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
  /**
   * The text the provider wraps a question and its state in, placeholders
   * included; its hash is folded into the verdict key, so a reworded prompt
   * never reuses an answer given to the old one. Absent = the version-3 prompt.
   */
  readonly promptTemplate?: string;
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
  /** Receiver-group questions (tournament blocks included) answered from the verdict store. */
  groupCacheHits: number;
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
  /** Eligible rows whose verdict is under its threshold — the provider's for a pick, the none threshold for none. */
  belowThreshold: number;
  /** Eligible rows whose verdict is at or above the provider threshold. */
  sitesEdged: number;
  /** Receiver groups holding a class menu, asked or answered from the store. */
  receiverGroups: number;
  /** Rows of those groups. */
  receiverGroupSites: number;
  /** Rows edged by their own receiver group's class verdict. */
  sitesEdgedByVerdict: number;
  /** Rows edged by a type fact propagated from another group's verdict (a chain hop downstream). */
  sitesEdgedByPropagation: number;
  /** Groups whose own accepted verdict disagreed with a propagated type fact; the direct verdict stood. */
  propagationConflicts: number;
  /** Receiver groups whose class set exceeded the menu limit and went to a tournament. */
  tournamentGroups: number;
  /** Most rounds any tournament ran. */
  tournamentRounds: number;
  /** Tournament block questions sent to the model this run, block 1 included. */
  tournamentQuestions: number;
  /** Tournament groups opened by block 1 — the classes the receiver's name matches. */
  namePriorGroups: number;
  /** Tournament groups settled by block 1 alone: its winner cleared the provider threshold. */
  earlyAcceptedGroups: number;
  /** Tournament groups not asked because the run's budget (`CODEGRAPH_RESIDUAL_TOURNAMENT_BUDGET`) ran out. */
  groupsSkippedByBudget: number;
  /** Receiver groups whose `[pick, none]` confirm question (`CODEGRAPH_RESIDUAL_CONFIRM_STAGE`) was answered, from the store or the model. */
  confirmQuestions: number;
  /** Receiver groups settled by a confirm answer at or above the provider threshold. */
  confirmAccepted: number;
  /** Method batches the model refused as too long, asked again over a window around their call lines. */
  windowedGroups: number;
  /** Provider requests sent, a requeued one counted each time. */
  requests: number;
  /** Most questions any sent request carried (`CODEGRAPH_RESIDUAL_MAX_QUESTIONS_PER_REQUEST` caps it). */
  maxQuestionsPerRequest: number;
  /** Median request latency, ms. */
  requestLatencyP50Ms: number;
  /** 95th-percentile request latency, ms. */
  requestLatencyP95Ms: number;
  /** Most requests in flight at once; `CODEGRAPH_RESIDUAL_CONCURRENCY` caps it. */
  peakInFlight: number;
  /** Eligible rows the model answered "none of these" for at or above `CODEGRAPH_RESIDUAL_NONE_THRESHOLD`. */
  externalByModel: number;
  /**
   * Rows whose accepted class — picked, or propagated from an upstream pick —
   * reads the member as a schema column: no edge, out of the recall denominator
   * like {@link externalByModel} (bd tea-rags-mcp-2m83f.55).
   */
  attributeByModel: number;
  /** Rows of a downstream hop whose receiver an accepted pick types as a core value (`Integer`, `String`): external. */
  externalByPropagation: number;
  /**
   * Distinct model edges stored. Until 2m83f.29 this counted sites (what
   * `sitesEdged` counts now); sites making the same call to the same target
   * share one edge.
   */
  edgesApplied: number;
  derived: ResidualDerivedState;
  durations: ResidualPassDurations;
  /**
   * The Qdrant `codegraph.*` payload heal run after a pass that changed the
   * model edges. Absent when the edges did not change, when no heal is wired,
   * or when the heal failed (logged).
   */
  payloadHeal?: { pointsRewritten: number; filesTouched: number };
}

/** A calibrated accept threshold's question shape (`cg_residual_calibration.stratum`). */
export type ResidualCalibrationStratum = "fullMenu" | "block1" | "none";

/** None-answer shares the outside share `pi` was solved from. */
export interface ResidualCalibrationNoneRates {
  residual: number;
  onMenu: number;
  external: number;
}

/**
 * One fitted threshold per language and stratum (`cg_residual_calibration`).
 * `threshold` is `null` when the fit found no cut — the caller keeps its default.
 */
export interface ResidualCalibrationRow {
  language: string;
  stratum: ResidualCalibrationStratum;
  threshold: number | null;
  lowerBound: number | null;
  n: number;
  pi: number | null;
  noneRates: ResidualCalibrationNoneRates | null;
  /** The model id the sample was asked with. */
  model: string;
  /** The question fold (prompt template, state builder, origin context) it was asked under. */
  templateHash: string;
  graphFingerprint: string;
  /** Epoch milliseconds. */
  createdAt: number;
}
