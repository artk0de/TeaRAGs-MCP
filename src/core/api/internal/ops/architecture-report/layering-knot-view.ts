import type { RelPath } from "../../../../contracts/types/codegraph.js";
import type {
  ComponentGraph,
  ComponentStableDependenciesReport,
  ConventionPrivacyReport,
  LayeringFeedbackEdge as DomainLayeringFeedbackEdge,
  HubLikeDependencyReport,
  LayeringKeepCost,
  LayeringKnotLookup,
  LayeringReport,
  LeakingAbstractionReport,
  MainSequenceReport,
} from "../../../../domains/trajectory/codegraph/symbols/index.js";
import type { SilentCouplingReport } from "../../../../domains/trajectory/codegraph/temporal/index.js";
import type { ArchitectureKnotMember, ArchitectureKnotView } from "../../../public/dto/architecture.js";
import { round3 } from "./architecture-report-value-format.js";
import { toLayeringBackEdgeViolation, toLayeringFeedbackEdge } from "./layering-findings.js";

/**
 * The knot view (bd tea-rags-mcp-r8hme.38): the lookup's full lists paged at
 * `[offset, offset + limit)` — members and cut edges by the same window,
 * back-edges capped at `limit` — the counts kept before paging. Each member
 * carries its coupling on the partition the knot was found in (bd
 * tea-rags-mcp-r8hme.39); each cut edge on the page its keep cost (bd
 * tea-rags-mcp-r8hme.40), priced only for the page — never the whole cut.
 */
export function knotView(
  lookup: Exclude<LayeringKnotLookup, { kind: "unknownComponent" }>,
  layeringPartition: ComponentGraph,
  instabilitySpread: number,
  keepCostsOf: (
    edges: readonly DomainLayeringFeedbackEdge[],
  ) => { edge: DomainLayeringFeedbackEdge; keepCost: LayeringKeepCost }[],
  limit: number,
  offset: number,
): ArchitectureKnotView {
  const head = {
    component: lookup.component,
    inKnot: lookup.kind === "inKnot",
    level: lookup.position.level,
    depth: lookup.position.depth,
    offset,
    limit,
  };
  if (lookup.kind === "notInKnot") return head;
  const { knot } = lookup;
  const end = offset + limit;
  const hasMore = end < knot.components.length || end < knot.feedbackArcSet.length;
  return {
    ...head,
    knot: {
      members: knot.components.slice(offset, end).map((component) => knotMember(component, layeringPartition)),
      memberCount: knot.components.length,
      instabilitySpread: round3(instabilitySpread),
      feedbackArcSet: keepCostsOf(knot.feedbackArcSet.slice(offset, end)).map(({ edge, keepCost }) => ({
        ...toLayeringFeedbackEdge(edge),
        keepCost,
      })),
      cutEdgeCount: knot.cutEdgeCount,
      levelsAfterCut: knot.levelsAfterCut,
      composition: knot.composition,
      backEdges: knot.backEdges.slice(0, limit).map(toLayeringBackEdgeViolation),
      ...(knot.outOfScopeMemberCount !== undefined ? { outOfScopeMemberCount: knot.outOfScopeMemberCount } : {}),
      ...(knot.outOfScopeFeedbackEdgeCount !== undefined
        ? { outOfScopeFeedbackEdgeCount: knot.outOfScopeFeedbackEdgeCount }
        : {}),
      ...(hasMore ? { nextOffset: end } : {}),
    },
  };
}

function knotMember(component: string, layeringPartition: ComponentGraph): ArchitectureKnotMember {
  const measured = layeringPartition.components.get(component);
  return {
    component,
    instability: round3(measured?.instability ?? 0),
    afferentCount: measured?.afferentCount ?? 0,
    efferentCount: measured?.efferentCount ?? 0,
  };
}

/**
 * Which findings sit inside one knot (bd tea-rags-mcp-r8hme.39). The knot's
 * members are components of the one partition every detector judges (bd
 * tea-rags-mcp-r8hme.52.7): a component is inside when it IS a member, a file
 * when its component is.
 */
export interface ArchitectureKnotMembership {
  holdsFile: (relPath: RelPath) => boolean;
  holdsComponent: (component: string) => boolean;
}

export function buildArchitectureKnotMembership(
  members: readonly string[],
  partition: ComponentGraph,
): ArchitectureKnotMembership {
  const memberSet = new Set(members);
  return {
    holdsFile: (relPath) => {
      const component = partition.componentOf.get(relPath);
      return component !== undefined && memberSet.has(component);
    },
    holdsComponent: (component) => memberSet.has(component),
  };
}

export interface ArchitectureDetectorReports {
  sdp: ComponentStableDependenciesReport;
  leaks: LeakingAbstractionReport;
  privacy: ConventionPrivacyReport;
  silent: SilentCouplingReport;
  mainSequence: MainSequenceReport;
  hubLikeDependency: HubLikeDependencyReport;
  /** Absent in knot mode: the view carries the knot's own back-edges. */
  layering?: LayeringReport;
}

/**
 * The detector reports narrowed to the findings inside the knot, before any
 * `limit` cap (bd tea-rags-mcp-r8hme.39) — so a page lists up to `limit`
 * in-knot findings per detector. Only the first page (`offset` 0) carries
 * them; later pages page the view alone. The summaries keep reading the
 * unfiltered reports.
 */
export function findingsInKnot(
  reports: Required<Omit<ArchitectureDetectorReports, "layering">>,
  membership: ArchitectureKnotMembership,
  offset: number,
): ArchitectureDetectorReports {
  const firstPage = offset === 0;
  const keep = <T>(items: readonly T[], inside: (item: T) => boolean): T[] => (firstPage ? items.filter(inside) : []);
  const { sdp, leaks, privacy, silent, mainSequence, hubLikeDependency } = reports;
  const bothFiles = (v: { sourceRelPath: RelPath; targetRelPath: RelPath }) =>
    membership.holdsFile(v.sourceRelPath) && membership.holdsFile(v.targetRelPath);
  return {
    sdp: {
      ...sdp,
      violations: keep(
        sdp.violations,
        (v) => membership.holdsComponent(v.sourceComponent) && membership.holdsComponent(v.targetComponent),
      ),
      rootCauses: keep(sdp.rootCauses, (r) => membership.holdsComponent(r.targetComponent)),
    },
    leaks: {
      ...leaks,
      violations: keep(leaks.violations, bothFiles),
      rootCauses: keep(
        leaks.rootCauses,
        (r) => membership.holdsComponent(r.moduleDir) || membership.holdsFile(r.facadeRelPath),
      ),
    },
    privacy: { ...privacy, violations: keep(privacy.violations, bothFiles) },
    silent: {
      ...silent,
      violations: keep(silent.violations, (v) => membership.holdsFile(v.relPathA) && membership.holdsFile(v.relPathB)),
      rootCauses: keep(silent.rootCauses, (r) => membership.holdsFile(r.relPath)),
    },
    mainSequence: {
      ...mainSequence,
      violations: keep(mainSequence.violations, (v) => membership.holdsComponent(v.component)),
    },
    hubLikeDependency: {
      ...hubLikeDependency,
      violations: keep(hubLikeDependency.violations, (v) => membership.holdsComponent(v.component)),
    },
  };
}
