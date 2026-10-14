import type {
  LayeringBackEdgeViolation as DomainLayeringBackEdgeViolation,
  LayeringFeedbackEdge as DomainLayeringFeedbackEdge,
  LayeringViolation as DomainLayeringViolation,
  LayeringReport,
} from "../../../../domains/trajectory/codegraph/symbols/index.js";
import type {
  ArchitectureViolation,
  LayeringBackEdgeArchitectureViolation,
  LayeringReportSummary,
} from "../../../public/dto/architecture.js";
import { round3 } from "./architecture-report-value-format.js";

/** Knot / composition-cycle members listed per finding (most depended-on first); `memberCount` keeps the total. */
export const LAYERING_KNOT_MEMBER_LIMIT = 20;

/** Feedback-arc-set edges listed per knot (heaviest first); `cutEdgeCount` keeps the total. */
export const LAYERING_FEEDBACK_EDGE_LIMIT = 10;

/** Parent↔nested pairs listed per composition cycle; `nestedPairCount` keeps the total. */
export const LAYERING_NESTED_PAIR_LIMIT = 10;

export function summariseLayering(report: LayeringReport): LayeringReportSummary {
  const { summary } = report;
  return {
    componentCount: summary.componentCount,
    componentEdgeCount: summary.componentEdgeCount,
    levelCount: summary.levelCount,
    coverage: round3(summary.coverage),
    coherence: round3(summary.coherence),
    knotCount: summary.knotCount,
    backEdgeCount: summary.backEdgeCount,
    abstractionBypassCount: summary.abstractionBypassCount,
    compositionCycleCount: summary.compositionCycleCount,
    islandCount: summary.islandCount,
    violationCount: summary.violationCount,
    informationalCount: summary.informationalCount,
    ...(summary.scope ? { outOfScopeFindingCount: summary.scope.outOfScopeFindingCount } : {}),
    ...(summary.foundation ? { foundation: summary.foundation } : {}),
  };
}

export function toLayeringArchitectureViolation(v: DomainLayeringViolation): ArchitectureViolation {
  switch (v.kind) {
    case "knot":
      return {
        detector: "layering",
        kind: "knot",
        components: v.components.slice(0, LAYERING_KNOT_MEMBER_LIMIT),
        evidence: {
          feedbackArcSet: v.feedbackArcSet.slice(0, LAYERING_FEEDBACK_EDGE_LIMIT).map(toLayeringFeedbackEdge),
          cutEdgeCount: v.cutEdgeCount,
          levelsAfterCut: v.levelsAfterCut,
          memberCount: v.components.length,
          instabilitySpread: round3(v.instabilitySpread),
          ...(v.outOfScopeMemberCount !== undefined ? { outOfScopeMemberCount: v.outOfScopeMemberCount } : {}),
          ...(v.outOfScopeFeedbackEdgeCount !== undefined
            ? { outOfScopeFeedbackEdgeCount: v.outOfScopeFeedbackEdgeCount }
            : {}),
          drillDown: v.drillDown,
        },
      };
    case "backEdge":
      return toLayeringBackEdgeViolation(v);
    case "abstractionBypass":
      return {
        detector: "layering",
        kind: "abstractionBypass",
        sourceComponent: v.sourceComponent,
        targetComponent: v.targetComponent,
        evidence: {
          bypassedComponent: v.bypassedComponent,
          concreteAbstractness: round3(v.concreteAbstractness),
          bypassedAbstractness: round3(v.bypassedAbstractness),
          callWeight: v.callWeight,
          implementedBy: { ...v.implementedBy },
        },
      };
    case "compositionCycle":
      return {
        detector: "layering",
        kind: "compositionCycle",
        components: v.components.slice(0, LAYERING_KNOT_MEMBER_LIMIT),
        evidence: {
          nestedPairs: v.nestedPairs.slice(0, LAYERING_NESTED_PAIR_LIMIT),
          memberCount: v.components.length,
          nestedPairCount: v.nestedPairs.length,
          ...(v.outOfScopeMemberCount !== undefined ? { outOfScopeMemberCount: v.outOfScopeMemberCount } : {}),
        },
      };
    case "island":
      return {
        detector: "layering",
        kind: "island",
        component: v.component,
        evidence: {
          height: v.height,
          depth: v.depth,
          afferentCount: v.afferentCount,
          instability: round3(v.instability),
        },
      };
  }
}

export function toLayeringBackEdgeViolation(v: DomainLayeringBackEdgeViolation): LayeringBackEdgeArchitectureViolation {
  return {
    detector: "layering",
    kind: "backEdge",
    sourceComponent: v.sourceComponent,
    targetComponent: v.targetComponent,
    evidence: {
      callWeight: v.callWeight,
      counterFlowWeight: v.counterFlowWeight,
      fileEdgeCount: v.fileEdgeCount,
      fileEdges: v.fileEdges,
    },
  };
}

export function toLayeringFeedbackEdge(edge: DomainLayeringFeedbackEdge) {
  return {
    sourceComponent: edge.sourceComponent,
    targetComponent: edge.targetComponent,
    callWeight: edge.callWeight,
    fileEdges: edge.fileEdges,
  };
}
