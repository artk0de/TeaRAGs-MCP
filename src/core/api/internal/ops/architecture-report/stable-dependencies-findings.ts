import {
  COMPONENT_CONTAINMENT_REASON,
  FACADE_AGGREGATION_REASON,
  type ComponentStableDependenciesReport,
} from "../../../../domains/trajectory/codegraph/symbols/index.js";
import type {
  ArchitectureRootCause,
  ArchitectureViolation,
  StableDependenciesReportSummary,
} from "../../../public/dto/architecture.js";

export const STABLE_DEPENDENCIES_EXCLUSION_REASONS = {
  facadeAggregations: FACADE_AGGREGATION_REASON,
  containment: COMPONENT_CONTAINMENT_REASON,
} as const;

export function summariseStableDependencies(
  report: ComponentStableDependenciesReport,
): StableDependenciesReportSummary {
  const { summary } = report;
  return {
    tolerance: summary.tolerance,
    minConnectionCount: summary.minConnectionCount,
    edgeCount: summary.edgeCount,
    componentCount: summary.componentCount,
    moduleComponentCount: summary.moduleComponentCount,
    directoryComponentCount: summary.directoryComponentCount,
    componentEdgeCount: summary.componentEdgeCount,
    judgedEdgeCount: summary.judgedEdgeCount,
    violationCount: summary.violationCount,
    rootCauseCount: report.rootCauses.length,
    excluded: { ...summary.excluded },
    exclusionReasons: STABLE_DEPENDENCIES_EXCLUSION_REASONS,
    ...(summary.scope ? { outOfScopeEdgeCount: summary.scope.outOfScopeEdgeCount } : {}),
  };
}

export function sdpRootCauses(report: ComponentStableDependenciesReport, limit: number): ArchitectureRootCause[] {
  return report.rootCauses.slice(0, limit).map(
    (r): ArchitectureRootCause => ({
      detector: "stableDependencies",
      targetComponent: r.targetComponent,
      targetInstability: r.targetInstability,
      violationCount: r.violationCount,
      maxInstabilityDelta: r.maxInstabilityDelta,
      sources: r.sources,
      cycleWithDependents: r.cycleWithDependents,
    }),
  );
}

export function sdpViolations(report: ComponentStableDependenciesReport, limit: number): ArchitectureViolation[] {
  return report.violations.slice(0, limit).map(
    (v): ArchitectureViolation => ({
      detector: "stableDependencies",
      sourceComponent: v.sourceComponent,
      targetComponent: v.targetComponent,
      evidence: {
        sourceInstability: v.sourceInstability,
        targetInstability: v.targetInstability,
        instabilityDelta: v.instabilityDelta,
        sourceAfferentCount: v.sourceAfferentCount,
        sourceEfferentCount: v.sourceEfferentCount,
        targetAfferentCount: v.targetAfferentCount,
        targetEfferentCount: v.targetEfferentCount,
        callWeight: v.callWeight,
        directoryRelation: v.directoryRelation,
        fileEdgeCount: v.fileEdgeCount,
        ...(v.compositionRoot ? { compositionRoot: v.compositionRoot } : {}),
        fileEdges: v.fileEdges,
      },
    }),
  );
}
