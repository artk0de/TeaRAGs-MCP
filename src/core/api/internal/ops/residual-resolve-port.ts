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
    groups: 0,
    asked: 0,
    answered: 0,
    tooLong: 0,
    failedGroups: 0,
    belowThreshold: 0,
    sitesEdged: 0,
    edgesApplied: 0,
    derived: "unchanged",
    durations: { readMs: 0, askMs: 0, applyMs: 0, recomputeMs: 0, totalMs: 0 },
  };
}
