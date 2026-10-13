import {
  renderDiffFindingSubject,
  type DiffDetectorFinding,
} from "../../../../contracts/types/diff-detector-finding.js";
import { groupSilentCouplingPairs } from "../../../../domains/trajectory/codegraph/temporal/index.js";
import {
  SILENT_COUPLING_GROUP_EVIDENCE_PARTNERS,
  silentCouplingGroupDrillDown,
  silentCouplingGroupPartners,
  type SilentCouplingGroupedPair,
} from "../silent-coupling-group-findings/index.js";
import type { DiffFamilyDetector } from "./diff-family-detector.js";
import { detectorStatus, format3, round3, withRenderedSubject } from "./shared.js";

/**
 * Silent coupling pairs involving a changed file — CONSUMED from the
 * production verdict (bd tea-rags-mcp-89k7k.1.10): the whole-repo detector
 * already applied the endpoint-class exclusions (test/generated/
 * documentation/unwalked/lift), the Wilson-strength cut and the
 * shared-neighbour explanation over the same snapshot; this family only
 * intersects the violation list with the diff. Re-judging raw partner rows
 * here is what let 19–98 historical src~test and CLAUDE.md~code pairs per
 * diff bury the diff-relevant findings.
 *
 * A violation is skipped when the diff itself answers it: the overlay adds
 * the pair's structural edge in either direction, or a pre-existing edge
 * stands in the indexed graph's reverse direction (a partner -> file edge —
 * without that check the "no structural edge" sentence below could be
 * false). Both sides in the diff is the review's own business, not a
 * finding (bd tea-rags-mcp-3kykc owns the partner-missing question) — and
 * "in the diff" means the whole change (`inChange`), never the capped scan
 * (bd tea-rags-mcp-lxbrr).
 *
 * The status row's `findingCount` stays the PAIR count; the listed findings
 * group pairs by shared endpoint (bd tea-rags-mcp-89k7k.1.14). Absent facts
 * answer silence — no findings, and no excluded block: a zero block over an
 * unwired port would claim pairs were judged.
 */
export const silentCouplingDetector: DiffFamilyDetector = {
  family: "silentCoupling",
  judge: ({ scope, overlay, inChange, graph, silentCouplingFacts: facts }) => {
    if (facts === undefined) {
      return {
        findings: [],
        status: Object.freeze({ ...detectorStatus("silentCoupling", 0), groupedFindingCount: 0 }),
      };
    }
    // Oriented changed file first: `relPathA` is the diff's side of the pair.
    const pairs: SilentCouplingGroupedPair[] = [];
    const reported = new Set<string>();
    for (const relPath of scope.changedFiles) {
      for (const violation of facts.violations) {
        if (violation.relPathA !== relPath && violation.relPathB !== relPath) continue;
        const partner = violation.relPathA === relPath ? violation.relPathB : violation.relPathA;
        if (inChange.has(partner)) continue;
        const subject = `${relPath} ~ ${partner}`;
        if (reported.has(subject)) continue;
        reported.add(subject);
        const explainedByOverlay =
          overlay.edgesFrom(relPath).some((edge) => edge.targetRelPath === partner) ||
          overlay.edgesFrom(partner).some((edge) => edge.targetRelPath === relPath);
        if (explainedByOverlay) continue;
        // Absent graph reads as no indexed reverse edge — same as an empty
        // one: the check exists to suppress, and what cannot be confirmed
        // cannot suppress.
        const structurallyVisible = graph?.edgesTo(relPath).some((indexed) => indexed.source === partner) ?? false;
        if (structurallyVisible) continue;
        pairs.push({
          relPathA: relPath,
          relPathB: partner,
          support: violation.support,
          strength: violation.strength,
          ...(violation.expectedSupport === undefined ? {} : { expectedSupport: violation.expectedSupport }),
        });
      }
    }
    // Pairs sharing an endpoint list as ONE finding (bd tea-rags-mcp-89k7k.1.14)
    // — the same partition get_architecture_report lists its violations by.
    const { groups, singletons } = groupSilentCouplingPairs(pairs);
    const findings: DiffDetectorFinding[] = [
      ...groups.map((group): DiffDetectorFinding => {
        const partners = silentCouplingGroupPartners(group);
        const endpoints = { kind: "fileGroup", relPath: group.relPath, partnerCount: partners.length } as const;
        const drillDown = silentCouplingGroupDrillDown(group.relPath, partners.length);
        return withRenderedSubject({
          detector: "silentCoupling",
          endpoints,
          evidence: { topPartners: partners.slice(0, SILENT_COUPLING_GROUP_EVIDENCE_PARTNERS) },
          detail: `${renderDiffFindingSubject(endpoints)} and the diff adds none; drill in: ${drillDown.hint}`,
          partners,
          drillDown,
        });
      }),
      ...singletons.map((pair): DiffDetectorFinding => {
        const endpoints = { kind: "filePair", sourceRelPath: pair.relPathA, targetRelPath: pair.relPathB } as const;
        return withRenderedSubject({
          detector: "silentCoupling",
          endpoints,
          evidence: {
            support: round3(pair.support),
            strength: round3(pair.strength),
            ...(pair.expectedSupport === undefined ? {} : { expectedSupport: round3(pair.expectedSupport) }),
          },
          detail:
            `strong co-change with no structural edge and the diff does not add one: ${renderDiffFindingSubject(endpoints)} ` +
            `(support ${format3(pair.support)}, strength ${format3(pair.strength)})`,
        });
      }),
    ];
    return {
      findings,
      status: Object.freeze({
        ...detectorStatus("silentCoupling", pairs.length),
        groupedFindingCount: findings.length,
        // The taxonomy's counters ride the silentCoupling row (bd
        // tea-rags-mcp-89k7k.1.10).
        excluded: facts.excluded,
        ...(facts.cochangeSignificance !== undefined ? { cochangeSignificance: facts.cochangeSignificance } : {}),
      }),
    };
  },
};
