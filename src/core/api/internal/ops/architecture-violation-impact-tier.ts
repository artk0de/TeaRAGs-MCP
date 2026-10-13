/**
 * Violation impact tiers (bd tea-rags-mcp-r8hme.53): how much a structural
 * violation costs in practice, judged per violation over the import edges that
 * carry it.
 *
 * - structural — wrong direction; no carrying edge co-changes beyond chance.
 * - active     — at least one carrying file edge's pair is admitted by the
 *                co-change significance gate (Poisson configuration null, BH
 *                over the full family — the gate silent coupling reads). The
 *                test is undirected: the edge and the detector already give
 *                the direction, and co-commits carry no order.
 * - critical   — active, and a source file of an admitted edge reaches (has
 *                transitive dependents) at or above the repo's reach cut: a
 *                change cascading into it endangers a large share of the
 *                system.
 *
 * Tierable = a finding made by import edges: Stable Dependencies, layering
 * back-edges, knots (their feedback-arc set) and abstraction bypasses, leaking
 * abstraction (facade and convention-privacy), norm misfits. A component-level
 * or history-only finding has no edge to test and carries no tier.
 */

import type { RelPath } from "../../../contracts/types/codegraph.js";
import {
  cochangeEvidenceEndpointExclusion,
  type CochangeSignificance,
} from "../../../domains/trajectory/codegraph/temporal/index.js";
import type {
  ArchitectureFileEdge,
  ArchitectureFileEdgeEndpoints,
  ArchitectureViolationImpactTier,
  ArchitectureViolationImpactTierCounts,
  ArchitectureViolationImpactTierNotApplicable,
  ArchitectureViolationImpactTierTag,
  ArchitectureViolationReachCutSummary,
} from "../../public/dto/architecture.js";
import type { ComponentEdgeCarrierIndex } from "./architecture-maintenance-cost.js";
import { compareCodePoints, round3 } from "./architecture-report/index.js";

/** Admitted carrying edges a violation lists; the count keeps the total. */
export const ADMITTED_CARRIER_PAIR_LIMIT = 3;

/** The detectors the tiers do not apply to — the summary states them, so an untiered finding is not read as structural. */
export const ARCHITECTURE_IMPACT_TIER_NOT_APPLICABLE: ArchitectureViolationImpactTierNotApplicable = {
  detectors: [
    "mainSequence",
    "hubLikeDependency",
    "silentCoupling",
    "shotgunSurgery",
    "layering.compositionCycle",
    "layering.island",
  ],
  reason: "component-level or history-only finding: no carrying import edge to test for co-change",
};

/**
 * Each judged file's reach and the repo cut over it: the propagation-cost
 * visibility fan-in (files transitively depending on it, itself included) and
 * that population's majority-floored Otsu cut.
 */
export interface ArchitectureFileReach {
  fanInOf: ReadonlyMap<RelPath, number>;
  admits: (fanIn: number) => boolean;
  fileCount: number;
}

/** Order of the tiers inside a family: critical first, untiered last. */
const TIER_ORDER: Record<ArchitectureViolationImpactTier, number> = { critical: 0, active: 1, structural: 2 };
const UNTIERED_ORDER = 3;

/** A carrying component edge — a knot's cut arc, with its (possibly capped) listed file edges. */
interface ImpactTierArc {
  sourceComponent: string;
  targetComponent: string;
  fileEdges?: readonly ArchitectureFileEdge[];
}

/** The fields a tierable violation names its carrying edges by — read structurally, like the carrier files. */
interface ImpactTierCarrierFields {
  detector?: string;
  kind?: string;
  sourceRelPath?: RelPath;
  targetRelPath?: RelPath;
  sourceComponent?: string;
  targetComponent?: string;
  feedbackArcSet?: readonly ImpactTierArc[];
  evidence?: { fileEdges?: readonly ArchitectureFileEdge[]; feedbackArcSet?: readonly ImpactTierArc[] };
}

/** Grades violations into impact tiers over one report's co-change gate, carrier edges and reach. */
export class ArchitectureViolationImpactTierModel {
  constructor(
    private readonly significance: CochangeSignificance,
    private readonly carriers: ComponentEdgeCarrierIndex,
    private readonly reach: ArchitectureFileReach,
    private readonly isDocumentation?: (relPath: RelPath) => boolean,
  ) {}

  /**
   * The tier and its evidence for `violation`, or `{}` when the tiers do not
   * apply to it. `uncapped`, when given, is the detector's own finding behind
   * a listed shape — a knot's whole feedback-arc set, which the listed form caps.
   */
  tagOf(violation: object, uncapped?: object): ArchitectureViolationImpactTierTag {
    // Read structurally: every violation shape is an object, the fields optional on all of them.
    const edges = this.carrierEdgesOf(violation, uncapped ?? violation);
    if (edges === undefined) return {};
    let carrierPairCount = 0;
    const admitted: ArchitectureFileEdgeEndpoints[] = [];
    for (const edge of edges) {
      if (cochangeEvidenceEndpointExclusion(edge.sourceRelPath, edge.targetRelPath, this.isDocumentation)) continue;
      carrierPairCount++;
      if (this.significance.admits(edge.sourceRelPath, edge.targetRelPath)) admitted.push(edge);
    }
    const evidence = {
      admittedCarrierPairCount: admitted.length,
      carrierPairCount,
      admittedCarrierPairs: admitted.slice(0, ADMITTED_CARRIER_PAIR_LIMIT),
    };
    if (admitted.length === 0) return { tier: "structural", tierEvidence: evidence };
    const furthestSource = this.furthestReachingSource(admitted);
    const dependentCount = furthestSource.fanIn - 1;
    const share = this.reach.fileCount > 1 ? dependentCount / (this.reach.fileCount - 1) : 0;
    return {
      tier: this.reach.admits(furthestSource.fanIn) ? "critical" : "active",
      tierEvidence: {
        ...evidence,
        sourceReach: { relPath: furthestSource.relPath, dependentCount, share: round3(share) },
      },
    };
  }

  /** The carrying file edges, deduplicated, or `undefined` for a finding the tiers do not apply to. */
  private carrierEdgesOf(
    violation: ImpactTierCarrierFields,
    uncapped: ImpactTierCarrierFields,
  ): ArchitectureFileEdgeEndpoints[] | undefined {
    switch (violation.detector ?? "") {
      case "stableDependencies":
        return this.componentEdges(violation);
      case "leakingAbstraction":
      case "norms":
        return violation.sourceRelPath !== undefined && violation.targetRelPath !== undefined
          ? [{ sourceRelPath: violation.sourceRelPath, targetRelPath: violation.targetRelPath }]
          : undefined;
      case "layering":
        if (violation.kind === "backEdge" || violation.kind === "abstractionBypass") {
          return this.componentEdges(violation);
        }
        if (violation.kind === "knot") {
          const arcs = uncapped.feedbackArcSet ?? uncapped.evidence?.feedbackArcSet ?? [];
          return uniqueEdges(
            arcs.flatMap((arc) => this.arcEdges(arc.sourceComponent, arc.targetComponent, arc.fileEdges)),
          );
        }
        return undefined;
      default:
        return undefined;
    }
  }

  private componentEdges(violation: ImpactTierCarrierFields): ArchitectureFileEdgeEndpoints[] | undefined {
    if (violation.sourceComponent === undefined || violation.targetComponent === undefined) return undefined;
    return uniqueEdges(
      this.arcEdges(violation.sourceComponent, violation.targetComponent, violation.evidence?.fileEdges),
    );
  }

  /** The partition's full edge list for a component edge; the listed sample only when the partition holds none. */
  private arcEdges(
    sourceComponent: string,
    targetComponent: string,
    listed: readonly ArchitectureFileEdge[] | undefined,
  ): readonly ArchitectureFileEdgeEndpoints[] {
    const edges = this.carriers.edgesBetween(sourceComponent, targetComponent);
    return edges.length > 0 ? edges : (listed ?? []);
  }

  /** The admitted edges' source with the most transitive dependents; ties by path. */
  private furthestReachingSource(admitted: readonly ArchitectureFileEdgeEndpoints[]): {
    relPath: RelPath;
    fanIn: number;
  } {
    let best: { relPath: RelPath; fanIn: number } | undefined;
    for (const { sourceRelPath } of admitted) {
      // A source outside the judged graph reaches only itself.
      const fanIn = this.reach.fanInOf.get(sourceRelPath) ?? 1;
      if (
        best === undefined ||
        fanIn > best.fanIn ||
        (fanIn === best.fanIn && compareCodePoints(sourceRelPath, best.relPath) < 0)
      ) {
        best = { relPath: sourceRelPath, fanIn };
      }
    }
    // `admitted` is never empty here.
    return best as { relPath: RelPath; fanIn: number };
  }
}

/** Sort key of a listed item's tier: critical first, then active, structural, untiered. */
export function impactTierOrder(item: ArchitectureViolationImpactTierTag): number {
  return item.tier === undefined ? UNTIERED_ORDER : TIER_ORDER[item.tier];
}

/** The highest tier among `members`, or `undefined` when none carries one. */
export function highestImpactTier(
  members: readonly ArchitectureViolationImpactTierTag[],
): ArchitectureViolationImpactTier | undefined {
  let highest: ArchitectureViolationImpactTier | undefined;
  for (const { tier } of members) {
    if (tier !== undefined && (highest === undefined || TIER_ORDER[tier] < TIER_ORDER[highest])) highest = tier;
  }
  return highest;
}

/** Tierable violations per tier. */
export function countImpactTiers(
  items: readonly ArchitectureViolationImpactTierTag[],
): ArchitectureViolationImpactTierCounts {
  const counts = { structural: 0, active: 0, critical: 0 };
  for (const { tier } of items) if (tier !== undefined) counts[tier]++;
  return counts;
}

/**
 * The reach cut as the summary shows it: the visibility fan-in cut moved to
 * the share scale (dependents over the other files), 3 decimals.
 */
export function reachCutSummary(
  cut: { method: "otsu" | "majority"; threshold: number; separability?: number },
  fileCount: number,
): ArchitectureViolationReachCutSummary {
  const share = fileCount > 1 ? Math.max(0, cut.threshold - 1) / (fileCount - 1) : 0;
  return {
    signal: "transitiveDependentShare",
    method: cut.method,
    threshold: round3(share),
    ...(cut.separability !== undefined ? { separability: round3(cut.separability) } : {}),
    fileCount,
  };
}

function uniqueEdges(edges: readonly ArchitectureFileEdgeEndpoints[]): ArchitectureFileEdgeEndpoints[] {
  const seen = new Set<string>();
  const distinctEdges: ArchitectureFileEdgeEndpoints[] = [];
  for (const { sourceRelPath, targetRelPath } of edges) {
    const key = `${sourceRelPath}\u0000${targetRelPath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    distinctEdges.push({ sourceRelPath, targetRelPath });
  }
  return distinctEdges;
}
