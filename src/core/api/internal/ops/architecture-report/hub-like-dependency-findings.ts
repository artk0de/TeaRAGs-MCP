import type { HubLikeDependencyReport } from "../../../../domains/trajectory/codegraph/symbols/index.js";
import type { ArchitectureViolation, HubLikeDependencyReportSummary } from "../../../public/dto/architecture.js";
import { round3, roundCompositionTableCut } from "./architecture-report-value-format.js";

/** The per-file reading a hub's churn averages — named in the summary. */
const HUB_LIKE_DEPENDENCY_CHURN_SIGNAL = "git.file.commitCount";

export function summariseHubLikeDependency(report: HubLikeDependencyReport): HubLikeDependencyReportSummary {
  const { summary } = report;
  const axis = (cut: HubLikeDependencyReport["summary"]["afferent"]) => ({
    threshold: round3(cut.threshold),
    thresholdMethod: cut.thresholdMethod,
    ...(cut.separability === undefined ? {} : { separability: round3(cut.separability) }),
    median: cut.median,
  });
  return {
    componentCount: summary.componentCount,
    judgedComponentCount: summary.judgedComponentCount,
    violationCount: summary.violationCount,
    minConnectionCount: summary.minConnectionCount,
    afferent: axis(summary.afferent),
    efferent: axis(summary.efferent),
    excluded: { ...summary.excluded },
    ...(summary.churnMeasured ? { churnSignal: HUB_LIKE_DEPENDENCY_CHURN_SIGNAL } : {}),
    ...(summary.scope ? { outOfScopeComponentCount: summary.scope.outOfScopeComponentCount } : {}),
    ...(summary.compositionTableCut
      ? { compositionTableCut: roundCompositionTableCut(summary.compositionTableCut) }
      : {}),
  };
}

export function hubLikeDependencyViolations(report: HubLikeDependencyReport, limit: number): ArchitectureViolation[] {
  return report.violations.slice(0, limit).map(
    (v): ArchitectureViolation => ({
      detector: "hubLikeDependency",
      component: v.component,
      componentKind: v.kind,
      facadeRelPath: v.facadeRelPath,
      evidence: {
        afferentCount: v.afferentCount,
        efferentCount: v.efferentCount,
        instability: round3(v.instability),
        fileCount: v.fileCount,
        dependentComponentCount: v.dependentComponentCount,
        dependencyComponentCount: v.dependencyComponentCount,
        topDependents: v.topDependents.map(roundNeighbour),
        topDependencies: v.topDependencies.map(roundNeighbour),
        transitiveImpact: v.transitiveImpact,
        ...(v.churn ? { churn: { value: round3(v.churn.value), measuredFileCount: v.churn.measuredFileCount } } : {}),
        ...(v.compositionRoot ? { compositionRoot: v.compositionRoot } : {}),
        ...(v.compositionTable ? { compositionTable: v.compositionTable } : {}),
        ...(v.parentSurface ? { parentSurface: v.parentSurface } : {}),
      },
    }),
  );
}

function roundNeighbour<T extends { callWeight: number }>(neighbour: T): T {
  return { ...neighbour, callWeight: round3(neighbour.callWeight) };
}
