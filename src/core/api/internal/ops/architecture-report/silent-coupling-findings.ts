import { extname } from "node:path";

import type { RelPath, TemporalCochangeGraph } from "../../../../contracts/types/codegraph.js";
import { silentCouplingGroupSubject } from "../../../../contracts/types/diff-detector-finding.js";
import {
  DOCUMENTATION_LANGUAGES,
  LANGUAGE_MAP,
} from "../../../../domains/ingest/pipeline/chunker/language-config/index.js";
import {
  computeSplitMergeVerdicts,
  groupSilentCouplingPairs,
  SILENT_COUPLING_EXPLAINED_REASON,
  type SilentCouplingReport,
  type SilentCouplingViolation,
  type SplitMergeVerdicts,
} from "../../../../domains/trajectory/codegraph/temporal/index.js";
import type {
  ArchitectureRootCause,
  ArchitectureViolation,
  SilentCouplingArchitectureViolation,
  SilentCouplingGroupArchitectureViolation,
  SilentCouplingReportSummary,
  SplitMergeReportSummary,
  SplitMergeVerdictsSummary,
} from "../../../public/dto/architecture.js";
import {
  SILENT_COUPLING_GROUP_EVIDENCE_PARTNERS,
  silentCouplingGroupDrillDown,
  silentCouplingGroupPartners,
} from "../silent-coupling-group-findings/index.js";
import { round3 } from "./architecture-report-value-format.js";

/**
 * Documentation by the same language table that sets `isDocumentation` on a
 * chunk — ingest owns it, and this layer is the one allowed to bridge ingest
 * and trajectory, so the detector receives the answer instead of the table.
 * Exported for the review sections' wiring, which feeds the same predicate to
 * the diff-scoped silent-coupling exclusions (bd tea-rags-mcp-89k7k.1.10) so
 * both paths answer documentation identically.
 */
export function isDocumentationPath(relPath: RelPath): boolean {
  const language = LANGUAGE_MAP[extname(relPath).toLowerCase()];
  return language !== undefined && DOCUMENTATION_LANGUAGES.has(language);
}

export function summariseSilentCoupling(report: SilentCouplingReport, limit: number): SilentCouplingReportSummary {
  const { summary } = report;
  const explained = summary.explainedCount > 0;
  return {
    built: summary.built,
    ...(summary.build ? { build: { ...summary.build } } : {}),
    pairCount: summary.pairCount,
    candidateCount: summary.candidateCount,
    strongCount: summary.strongCount,
    strongLinkedCount: summary.strongLinkedCount,
    violationCount: summary.violationCount,
    groupedFindingCount: groupedSilentCouplingFindingCount(report.violations),
    rootCauseCount: summary.rootCauseCount,
    strengthThreshold: summary.strengthThreshold,
    strengthThresholdMethod: summary.strengthThresholdMethod,
    ...(summary.strengthSeparability === undefined
      ? {}
      : { strengthSeparability: Math.round(summary.strengthSeparability * 1000) / 1000 }),
    ...(summary.sharedNeighbourSignificance
      ? { sharedNeighbourSignificance: { ...summary.sharedNeighbourSignificance } }
      : {}),
    excluded: { ...summary.excluded, explainedBySharedNeighbour: summary.explainedCount },
    ...(summary.cochangeSignificance ? { cochangeSignificance: { ...summary.cochangeSignificance } } : {}),
    ...(explained ? { exclusionReasons: { explainedBySharedNeighbour: SILENT_COUPLING_EXPLAINED_REASON } } : {}),
    ...(explained
      ? { explainedPairs: report.explained.slice(0, limit).map(toSilentCouplingArchitectureViolation) }
      : {}),
    ...(summary.scope ? { outOfScopePairCount: summary.scope.outOfScopePairCount } : {}),
  };
}

/** Groups plus ungrouped pairs — the findings `silentCouplingArchitectureViolations` lists before `limit`. */
function groupedSilentCouplingFindingCount(violations: readonly SilentCouplingViolation[]): number {
  const { groups, singletons } = groupSilentCouplingPairs(violations);
  return groups.length + singletons.length;
}

function roundTo3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * The split/merge block (bd tea-rags-mcp-c3v6o): the report's own component
 * partition judged against the same co-change build silent coupling reads.
 * Absence of data is silence — no build, or a build that persisted no bundle
 * membership (pre-042 index, nothing admitted), reports `built: false` with
 * the reason, never zeros posing as verdicts. Provenance rides whenever a
 * build exists, so a not-built block still names what was absent.
 */
export function summariseSplitMerge(
  cochange: TemporalCochangeGraph,
  componentOf: ReadonlyMap<RelPath, string>,
): SplitMergeReportSummary {
  const { meta } = cochange;
  if (!meta) return { built: false, reason: "noCochangeBuild" };
  const provenance = { head: meta.head, builtAt: meta.builtAt };
  if (!cochange.bundles || cochange.bundles.size === 0) {
    return { built: false, reason: "noBundleMembership", ...provenance };
  }
  return {
    built: true,
    ...provenance,
    verdicts: toSplitMergeVerdictsSummary(
      computeSplitMergeVerdicts({ components: { componentOf }, edges: cochange.edges, bundles: cochange.bundles }),
    ),
  };
}

function toSplitMergeVerdictsSummary(verdicts: SplitMergeVerdicts): SplitMergeVerdictsSummary {
  return {
    splitCandidates: verdicts.splitCandidates.map((candidate) => ({
      component: candidate.component,
      clusters: candidate.clusters,
      largestWeightShare: round3(candidate.largestWeightShare),
      files: candidate.files.map((files) => [...files]),
    })),
    mergeCandidates: verdicts.mergeCandidates.map((candidate) => ({
      componentA: candidate.componentA,
      componentB: candidate.componentB,
      support: candidate.support,
      strength: round3(candidate.strength),
      changesA: candidate.changesA,
      changesB: candidate.changesB,
    })),
    threshold: verdicts.threshold,
    thresholdMethod: verdicts.thresholdMethod,
    excluded: { ...verdicts.excluded },
  };
}

export function silentRootCauses(report: SilentCouplingReport, limit: number): ArchitectureRootCause[] {
  return report.rootCauses.slice(0, limit).map(
    (r): ArchitectureRootCause => ({
      detector: "silentCoupling",
      relPath: r.relPath,
      violationCount: r.violationCount,
      maxStrength: r.maxStrength,
      partners: r.partners,
    }),
  );
}

export function silentViolations(report: SilentCouplingReport, limit: number): ArchitectureViolation[] {
  return silentCouplingArchitectureViolations(report.violations, limit);
}

/**
 * The silent-coupling violations as listed (bd tea-rags-mcp-89k7k.1.14): pairs
 * sharing an endpoint ({@link groupSilentCouplingPairs}) become ONE grouped
 * finding each — greedy order, most pairs first — then the ungrouped pairs in
 * the detector's strongest-first order. Grouping reads EVERY violation, so a
 * group's `partners` is complete; `limit` caps the findings, not the pairs.
 */
export function silentCouplingArchitectureViolations(
  violations: readonly SilentCouplingViolation[],
  limit: number,
): ArchitectureViolation[] {
  const { groups, singletons } = groupSilentCouplingPairs(violations);
  return [
    ...groups.map((group): SilentCouplingGroupArchitectureViolation => {
      const partners = silentCouplingGroupPartners(group);
      return {
        detector: "silentCoupling",
        kind: "group",
        relPath: group.relPath,
        subject: silentCouplingGroupSubject(group.relPath, partners.length),
        partnerCount: partners.length,
        evidence: {
          topPartners: partners.slice(0, SILENT_COUPLING_GROUP_EVIDENCE_PARTNERS),
          maxStrength: partners[0].strength,
          drillDown: silentCouplingGroupDrillDown(group.relPath, partners.length),
        },
        partners,
      };
    }),
    ...singletons.map(toSilentCouplingArchitectureViolation),
  ].slice(0, limit);
}

function toSilentCouplingArchitectureViolation(v: SilentCouplingViolation): SilentCouplingArchitectureViolation {
  return {
    detector: "silentCoupling",
    sourceRelPath: v.relPathA,
    targetRelPath: v.relPathB,
    evidence: {
      support: v.support,
      confidenceAB: v.confidenceAB,
      confidenceBA: v.confidenceBA,
      lift: v.lift,
      strength: v.strength,
      ...(v.expectedSupport === undefined ? {} : { expectedSupport: roundTo3(v.expectedSupport) }),
      lastCoChangeAt: v.lastCoChangeAt,
      sampleCommits: v.sampleCommits,
      structuralVisibility: v.structuralVisibility,
      directoryRelation: v.directoryRelation,
      ...(v.explainedBy
        ? { explainedBy: { relPath: v.explainedBy.relPath, weight: roundTo3(v.explainedBy.weight) } }
        : {}),
    },
  };
}
