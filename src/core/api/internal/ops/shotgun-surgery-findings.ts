/**
 * The architecture report's shotgun-surgery section (bd tea-rags-mcp-r8hme.50):
 * the detector run over the report's adoption partition and component graph —
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
import { FIND_CO_CHANGED_LIMIT_MAX } from "./silent-coupling-group-findings.js";

/** The shotgun-surgery run: the detector's report, or why there is none. */
export type ShotgunSurgeryRun =
  | { built: true; head: string; builtAt: number; report: ShotgunSurgeryReport }
  | { built: false; summary: ShotgunSurgeryReportSummary };

/** Judge the co-change build's bundles over the report's component partition and graph. */
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
      componentOf: components.componentOf,
      componentDependencies: components.dependencies,
      bundles: cochange.bundles,
      ...(cochange.bundleBursts ? { bundleBursts: cochange.bundleBursts } : {}),
      ...(cochange.bundleCommits ? { bundleCommits: cochange.bundleCommits } : {}),
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
    unitCount: summary.unitCount,
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
    violationCount: summary.violationCount,
    ...(summary.sharedNeighbourThreshold === undefined
      ? {}
      : { sharedNeighbourThreshold: roundTo3(summary.sharedNeighbourThreshold) }),
    sharedNeighbourThresholdMethod: summary.sharedNeighbourThresholdMethod,
    ...(summary.outOfScopeSetCount === undefined ? {} : { outOfScopeSetCount: summary.outOfScopeSetCount }),
  };
}

/** The unexplained spreads, strongest first, capped at `limit`. */
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
      `(${spread.islands.length} unlinked islands; null expects ${roundTo3(spread.expectedSupport)})`,
    evidence: {
      support: spread.support,
      expectedSupport: roundTo3(spread.expectedSupport),
      strength: roundTo3(spread.strength),
      componentChanges: spread.componentChanges,
      islands: spread.islands,
      exemplarFiles: spread.exemplarFiles,
      sampleCommits: spread.sampleCommits,
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
