import type { PhysicalCollectionName } from "../../../contracts/types/collection-identity.js";
import type { ResidualPassMode, ResidualPassReport } from "../../../domains/trajectory/codegraph/residual/types.js";
import type { ProgressCallback } from "../../../types.js";

/** What the CLI-driven residual pass asks of the resolution ops. */
export interface ResidualResolvePortRequest {
  logicalName: string;
  physicalCollectionName: PhysicalCollectionName;
  projectRoot: string;
  model: string;
  /** `ask` queries the model; `cacheOnly` re-applies stored verdicts. Defaults to `ask` in the ops. */
  mode?: ResidualPassMode;
  onProgress?: ProgressCallback;
}

/** An index run's request: `model` only when the run was given `--resolve-residual`. */
export type ResidualAfterIndexRequest = Omit<ResidualResolvePortRequest, "model" | "mode"> & { model?: string };

/** The slice of the residual resolution ops `IndexingOps` consumes. */
export interface ResidualResolvePort {
  /** `IndexingOps#resolveResidual` — a pass on the current generation. */
  resolve: (request: ResidualResolvePortRequest) => Promise<ResidualPassReport>;
  /**
   * The pass an index run ends with; `undefined` when none was due. An
   * implementation without it ends index runs with no pass.
   */
  resolveAfterIndex?: (request: ResidualAfterIndexRequest) => Promise<ResidualPassReport | undefined>;
  /**
   * Threshold per model a pass applies edges at (`{ kev: 0.7 }`); the index
   * status counts a model edge as resolving its site only at or above it.
   */
  readonly thresholds?: Readonly<Record<string, number>>;
}

/** Report of a pass that could not start; the same shape the pass itself returns when skipped. */
export function skippedResidualReport(reason: string, mode: ResidualPassMode): ResidualPassReport {
  return {
    outcome: "skipped",
    reason,
    mode,
    sites: 0,
    menuOverflow: 0,
    menuTooSmall: 0,
    cacheHits: 0,
    groupCacheHits: 0,
    groups: 0,
    asked: 0,
    answered: 0,
    tooLong: 0,
    failedGroups: 0,
    abortedGroups: 0,
    requeuedGroups: 0,
    belowThreshold: 0,
    sitesEdged: 0,
    receiverGroups: 0,
    receiverGroupSites: 0,
    sitesEdgedByVerdict: 0,
    sitesEdgedByPropagation: 0,
    propagationConflicts: 0,
    tournamentGroups: 0,
    tournamentRounds: 0,
    tournamentQuestions: 0,
    namePriorGroups: 0,
    earlyAcceptedGroups: 0,
    groupsSkippedByBudget: 0,
    windowedGroups: 0,
    requests: 0,
    maxQuestionsPerRequest: 0,
    requestLatencyP50Ms: 0,
    requestLatencyP95Ms: 0,
    peakInFlight: 0,
    externalByModel: 0,
    attributeByModel: 0,
    externalByPropagation: 0,
    edgesApplied: 0,
    derived: "unchanged",
    durations: { readMs: 0, askMs: 0, applyMs: 0, recomputeMs: 0, totalMs: 0 },
  };
}
