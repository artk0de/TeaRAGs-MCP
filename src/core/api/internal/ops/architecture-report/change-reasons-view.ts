import type { RelPath, TemporalCochangeGraph } from "../../../../contracts/types/codegraph.js";
import {
  extractChangeReasons,
  type ChangeReasonCommit,
} from "../../../../domains/trajectory/codegraph/temporal/index.js";
import type { ArchitectureChangeReasonsReport } from "../../../public/dto/architecture.js";
import { round3 } from "./architecture-report-value-format.js";

/**
 * The change-reasons view (bd tea-rags-mcp-psh3j): the co-change build's
 * admitted commits — each bundle is one commit, carrying its files and the
 * task ids its message names — over the report's own component partition.
 * Absence of substrate is silence: no build, no bundle membership, or a build
 * that recorded no task ids (pre-045) reports `built: false` with the reason,
 * never an empty reason set posing as a measurement.
 */
export function changeReasonsView(
  cochange: TemporalCochangeGraph,
  componentOf: ReadonlyMap<RelPath, string>,
  limit: number,
): ArchitectureChangeReasonsReport {
  const { meta } = cochange;
  if (!meta) return { built: false, reason: "noCochangeBuild" };
  const provenance = { head: meta.head, builtAt: meta.builtAt };
  if (!cochange.bundles || cochange.bundles.size === 0) {
    return { built: false, reason: "noBundleMembership", ...provenance };
  }
  const { bundleTaskIds } = cochange;
  if (!bundleTaskIds || bundleTaskIds.size === 0) return { built: false, reason: "noTaskIdRecord", ...provenance };

  const commits: ChangeReasonCommit[] = [...cochange.bundles].map(([id, files]) => ({
    taskIds: bundleTaskIds.get(id) ?? [],
    files,
  }));
  const extraction = extractChangeReasons({ commits, componentOf });
  if (!extraction.available) {
    return {
      built: true,
      ...provenance,
      available: false,
      unavailable: { ...extraction.unavailable, taskIdCommitShare: round3(extraction.unavailable.taskIdCommitShare) },
    };
  }
  return {
    built: true,
    ...provenance,
    available: true,
    taskIdCommitShare: round3(extraction.taskIdCommitShare),
    moduleCount: extraction.modules.length,
    modules: extraction.modules.slice(0, limit),
  };
}
