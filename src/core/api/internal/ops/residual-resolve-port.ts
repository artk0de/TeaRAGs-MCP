import type { ResidualPassMode, ResidualPassReport } from "../../../domains/trajectory/codegraph/residual/types.js";
import type { ProgressCallback } from "../../../types.js";

/** What the CLI-driven residual pass asks of the resolution ops. */
export interface ResidualResolvePortRequest {
  logicalName: string;
  physicalCollectionName: string;
  projectRoot: string;
  model: string;
  /** `ask` queries the model; `cacheOnly` re-applies stored verdicts. Defaults to `ask` in the ops. */
  mode?: ResidualPassMode;
  onProgress?: ProgressCallback;
}

/** The slice of the residual resolution ops `IndexingOps#resolveResidual` consumes. */
export interface ResidualResolvePort {
  resolve: (request: ResidualResolvePortRequest) => Promise<ResidualPassReport>;
}

/** Report of a pass that could not start; the same shape the pass itself returns when skipped. */
export function skippedResidualReport(reason: string, mode: ResidualPassMode): ResidualPassReport {
  return {
    outcome: "skipped",
    reason,
    mode,
    sites: 0,
    menuOverflow: 0,
    cacheHits: 0,
    groups: 0,
    asked: 0,
    answered: 0,
    tooLong: 0,
    failedGroups: 0,
    belowThreshold: 0,
    edgesApplied: 0,
    durations: { readMs: 0, askMs: 0, applyMs: 0, totalMs: 0 },
  };
}
