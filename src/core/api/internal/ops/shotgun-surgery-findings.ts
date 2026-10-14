/**
 * The architecture report's shotgun-surgery section (bd tea-rags-mcp-r8hme.50):
 * the detector run over the report's one component partition and graph —
 * the partition split/merge judges — and its summary and findings in the
 * report's contract. Absence of data is silence: no co-change build, or a
 * build that persisted no bundle membership, reports `built: false` with the
 * reason, never zeros posing as verdicts.
 */

import type { TemporalCochangeGraph } from "../../../contracts/types/codegraph.js";
import type { ComponentGraph } from "../../../domains/trajectory/codegraph/symbols/index.js";
import {
  detectShotgunSurgery,
  type ShotgunSurgeryReport,
  type ShotgunSurgerySpread,
} from "../../../domains/trajectory/codegraph/temporal/index.js";
import type {
  ShotgunSurgeryArchitectureViolation,
  ShotgunSurgeryReportSummary,
} from "../../public/dto/architecture.js";
import { FIND_CO_CHANGED_LIMIT_MAX } from "./silent-coupling-group-findings/index.js";

/** The shotgun-surgery run: the detector's report, or why there is none. */
export type ShotgunSurgeryRun =
  | { built: true; head: string; builtAt: number; report: ShotgunSurgeryReport }
  | { built: false; summary: ShotgunSurgeryReportSummary };

/**
 * Judge the co-change build's bundles over the report's component partition
 * and graph. The bundles' task ids join a burst's commits into logical
 * changes (bd tea-rags-mcp-09c4m); their per-file line counts ride along
 * (bd tea-rags-mcp-dm61n).
 */
export function runShotgunSurgery(
  cochange: TemporalCochangeGraph,
  components: ComponentGraph,
  sourcePathPattern: string | undefined,
): ShotgunSurgeryRun {
  const { meta } = cochange;
  if (!meta) return { built: false, summary: { built: false, reason: "noCochangeBuild" } };
  if (!cochange.bundles || cochange.bundles.size === 0) {
    return {
      built: false,
      summary: { built: false, reason: "noBundleMembership", head: meta.head, builtAt: meta.builtAt },
    };
  }
  return {
    built: true,
    head: meta.head,
    builtAt: meta.builtAt,
    report: detectShotgunSurgery({
      // The co-change reading groups by constant namespace where a path spells
      // one (bd tea-rags-mcp-r8hme.52.15); the structural detectors keep the
      // path partition.
      componentOf: components.namespaceGrouping?.componentOf ?? components.componentOf,
      componentDependencies: components.namespaceGrouping?.dependencies ?? components.dependencies,
      bundles: cochange.bundles,
      ...(cochange.bundleBursts ? { bundleBursts: cochange.bundleBursts } : {}),
      ...(cochange.bundleCommits ? { bundleCommits: cochange.bundleCommits } : {}),
      ...(cochange.bundleTaskIds ? { bundleTaskIds: cochange.bundleTaskIds } : {}),
      ...(cochange.bundleFileLines ? { bundleFileLines: cochange.bundleFileLines } : {}),
      ...(cochange.bundleTimestamps ? { bundleTimestamps: cochange.bundleTimestamps } : {}),
      ...(cochange.bundleRenameSweeps ? { bundleRenameSweeps: cochange.bundleRenameSweeps } : {}),
      ...(sourcePathPattern ? { sourcePathPattern } : {}),
    }),
  };
}

export function summariseShotgunSurgery(run: ShotgunSurgeryRun): ShotgunSurgeryReportSummary {
  if (!run.built) return run.summary;
  const { summary } = run.report;
  return {
    built: true,
    head: run.head,
    builtAt: run.builtAt,
    burstCount: summary.burstCount,
    ...(summary.mechanicalTestedCount === undefined ? {} : { mechanicalTestedCount: summary.mechanicalTestedCount }),
    ...(summary.mechanicalCommitCount === undefined ? {} : { mechanicalCommitCount: summary.mechanicalCommitCount }),
    ...(summary.renameSweepCommitCount === undefined ? {} : { renameSweepCommitCount: summary.renameSweepCommitCount }),
    ...(summary.echoCandidatePairCount === undefined ? {} : { echoCandidatePairCount: summary.echoCandidatePairCount }),
    ...(summary.echoPairCount === undefined ? {} : { echoPairCount: summary.echoPairCount }),
    ...(summary.lifecycleCandidatePairCount === undefined
      ? {}
      : { lifecycleCandidatePairCount: summary.lifecycleCandidatePairCount }),
    ...(summary.lifecyclePairCount === undefined ? {} : { lifecyclePairCount: summary.lifecyclePairCount }),
    ...(summary.retirementTestedCount === undefined ? {} : { retirementTestedCount: summary.retirementTestedCount }),
    ...(summary.retirementUnitCount === undefined ? {} : { retirementUnitCount: summary.retirementUnitCount }),
    ...(summary.retiredSpreadCount === undefined ? {} : { retiredSpreadCount: summary.retiredSpreadCount }),
    unitCount: summary.unitCount,
    ...(summary.umbrellaTaskIdCut === undefined ? {} : { umbrellaTaskIdCut: summary.umbrellaTaskIdCut }),
    umbrellaTaskIdCount: summary.umbrellaTaskIdCount,
    ...(summary.typicalChangeWidth === undefined ? {} : { typicalChangeWidth: summary.typicalChangeWidth }),
    wideUnitCount: summary.wideUnitCount,
    widthThreshold: summary.widthThreshold,
    widthThresholdMethod: summary.widthThresholdMethod,
    ...(summary.widthSeparability === undefined ? {} : { widthSeparability: roundTo3(summary.widthSeparability) }),
    candidateSetCount: summary.candidateSetCount,
    familySize: summary.familySize,
    q: summary.q,
    admittedSetCount: summary.admittedSetCount,
    spreadCount: summary.spreadCount,
    explainedCount: summary.explainedCount,
    chainExplainedCount: summary.chainExplainedCount,
    violationCount: summary.violationCount,
    nestedFindingCount: summary.nestedFindingCount,
    ...(summary.sharedNeighbourThreshold === undefined
      ? {}
      : { sharedNeighbourThreshold: roundTo3(summary.sharedNeighbourThreshold) }),
    sharedNeighbourThresholdMethod: summary.sharedNeighbourThresholdMethod,
    ...(summary.outOfScopeSetCount === undefined ? {} : { outOfScopeSetCount: summary.outOfScopeSetCount }),
  };
}

/** The unexplained spreads, most surprising first (family evidence), capped at `limit`. */
export function shotgunSurgeryViolations(run: ShotgunSurgeryRun, limit: number): ShotgunSurgeryArchitectureViolation[] {
  if (!run.built) return [];
  return run.report.findings.slice(0, limit).map(toShotgunSurgeryViolation);
}

function toShotgunSurgeryViolation(spread: ShotgunSurgerySpread): ShotgunSurgeryArchitectureViolation {
  const drillLimit = FIND_CO_CHANGED_LIMIT_MAX;
  return {
    detector: "shotgunSurgery",
    components: spread.components,
    subject:
      `${spread.support} changes each touched all ${spread.components.length} components ` +
      `(${spread.islands.length} unlinked islands; weighted ${roundTo3(spread.weightedSupport)}, ` +
      `null expects ${roundTo3(spread.expectedSupport)})`,
    evidence: {
      support: spread.support,
      weightedSupport: roundTo3(spread.weightedSupport),
      expectedSupport: roundTo3(spread.expectedSupport),
      strength: roundTo3(spread.strength),
      familyEvidence: roundTo3(spread.familyEvidence),
      componentChanges: spread.componentChanges,
      islands: spread.islands,
      exemplarFiles: spread.exemplarFiles,
      carrierFiles: spread.carrierFiles,
      sampleCommits: spread.sampleCommits,
      sampleChanges: spread.sampleChanges,
      ...(spread.nested
        ? {
            nested: spread.nested.map(({ components, support, familyEvidence }) => ({
              components,
              support,
              familyEvidence: roundTo3(familyEvidence),
            })),
          }
        : {}),
      drillDown: {
        tool: "find_co_changed",
        files: spread.exemplarFiles,
        limit: drillLimit,
        hint:
          `call find_co_changed(files: ${JSON.stringify(spread.exemplarFiles)}, limit: ${drillLimit}) ` +
          "to list the file-level partners behind this spread",
      },
    },
  };
}

function roundTo3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
