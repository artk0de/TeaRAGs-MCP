/**
 * Impact tiers on the review side (bd tea-rags-mcp-r8hme.53 T2): the
 * architecture section's two judge runs already tag every tierable report
 * violation (T1, `ArchitectureViolationImpactTierModel`); this module carries
 * those tiers onto what the section lists, by the same stable keys the delta
 * compares (`diffDetectorFindingKey` == `architectureViolationKey`).
 *
 * - An INTRODUCED finding takes the overlaid run's tier — the violation exists
 *   only there. Any other finding with a report counterpart takes the base
 *   run's tier — the violation the change found. A diff-only family, or a key
 *   neither run holds, carries none.
 * - A PERSISTING violation the diff touches whose tier is active or critical is
 *   not collapsed: the edit lands on a live cascade, so it moves to
 *   `change.touchedActive`. Touched = a finding of the diff run names it, or a
 *   changed file sits on one of its carrying edges. Structural persisting
 *   violations stay in the compact `persisting` list.
 *
 * The co-change family the review judges is the QUERY family for every pair
 * the diff touches — the history minus the diff's own commits, so the change
 * cannot confirm itself — and the full family for every other pair (a pair off
 * the diff draws no support from the diff's commits).
 * {@link composeReviewCochangeSignificance} builds that gate once from the two
 * passes the section already needs — the query pass silent coupling reads and
 * ONE full pass — and both judge runs read it, instead of each judge computing
 * its own full pass.
 */

import {
  architectureViolationKey,
  diffDetectorFindingKey,
} from "../../../../contracts/types/architecture-finding-key.js";
import type { ArchitectureViolation } from "../../../../contracts/types/architecture-report.js";
import type { RelPath } from "../../../../contracts/types/codegraph.js";
import type { DiffDetectorFinding } from "../../../../contracts/types/diff-detector-finding.js";
import type { CochangeSignificance } from "../../../../domains/trajectory/codegraph/temporal/index.js";
import type { ArchitectureChangeSubject, ArchitectureTouchedActiveSubject } from "../../../public/dto/review.js";
import {
  violationChangeSubject,
  withCanonicalPaths,
  type ArchitectureViolationDelta,
} from "../architecture-violation-delta.js";

/** The tier each report violation key carries in the run that holds it. */
export class ArchitectureViolationTierLookup {
  private readonly baseByKey: ReadonlyMap<string, ArchitectureViolation>;

  constructor(
    baseViolations: readonly ArchitectureViolation[],
    private readonly delta: ArchitectureViolationDelta,
  ) {
    const baseByKey = new Map<string, ArchitectureViolation>();
    for (const violation of baseViolations) {
      const key = architectureViolationKey(violation);
      if (!baseByKey.has(key)) baseByKey.set(key, violation);
    }
    this.baseByKey = baseByKey;
  }

  /** The overlaid run's tier for an introduced key, the base run's for one it holds, else none. */
  tierOf(key: string): ArchitectureViolation["tier"] {
    const introduced = this.delta.introduced.get(key);
    if (introduced !== undefined) return introduced.tier;
    return this.baseByKey.get(key)?.tier;
  }

  /** Each key both runs hold, with its base violation. */
  *persistingViolations(): Iterable<[string, ArchitectureViolation]> {
    for (const key of this.delta.persisting) {
      const violation = this.baseByKey.get(key);
      if (violation !== undefined) yield [key, violation];
    }
  }
}

/** `findings` with each one's report violation tier stamped on, keyed through the diff's renames. */
export function stampDiffFindingImpactTiers(
  findings: readonly DiffDetectorFinding[],
  tiers: ArchitectureViolationTierLookup,
  renamedFrom?: ReadonlyMap<string, string>,
): DiffDetectorFinding[] {
  return findings.map((finding) => {
    const tier = tiers.tierOf(canonicalFindingKey(finding, renamedFrom));
    return tier === undefined ? finding : { ...finding, tier };
  });
}

/** What the section needs to separate the touched live violations from the collapsed ones. */
export interface TouchedActiveSeparationInput {
  /** The collapsed list, tiers carried. */
  persisting: readonly ArchitectureChangeSubject[];
  /** Every finding of the diff run, before the collapse. */
  findings: readonly DiffDetectorFinding[];
  tiers: ArchitectureViolationTierLookup;
  changedFiles: readonly RelPath[];
  /** The files on a report violation's carrying edges. */
  carrierFilesOf: (violation: object) => readonly RelPath[];
  renamedFrom?: ReadonlyMap<string, string>;
}

/**
 * Split the persisting violations the diff touches by tier: active and
 * critical move to `touchedActive`, structural ones stay collapsed. A
 * persisting violation no finding names joins `touchedActive` when a changed
 * file is on its carrying edges.
 */
export function separateTouchedActiveViolations(input: TouchedActiveSeparationInput): {
  persisting: ArchitectureChangeSubject[];
  touchedActive: ArchitectureTouchedActiveSubject[];
} {
  const persisting: ArchitectureChangeSubject[] = [];
  const touchedActive: ArchitectureTouchedActiveSubject[] = [];
  for (const changeSubject of input.persisting) {
    if (isLiveSubject(changeSubject)) touchedActive.push(changeSubject);
    else persisting.push(changeSubject);
  }
  const named = new Set(input.findings.map((finding) => canonicalFindingKey(finding, input.renamedFrom)));
  const changed = new Set(input.changedFiles);
  for (const [key, violation] of input.tiers.persistingViolations()) {
    if (named.has(key) || (violation.tier !== "active" && violation.tier !== "critical")) continue;
    if (!input.carrierFilesOf(violation).some((relPath) => changed.has(relPath))) continue;
    const changeSubject = violationChangeSubject(key, violation);
    if (isLiveSubject(changeSubject)) touchedActive.push(changeSubject);
  }
  return { persisting, touchedActive };
}

/**
 * The co-change gate a review judges with: a pair touching `diffFiles` by the
 * query family (history minus the diff's own commits), any other pair by the
 * full family. The summary is the full pass's — the gate the report states.
 */
export function composeReviewCochangeSignificance(
  full: CochangeSignificance,
  query: CochangeSignificance,
  diffFiles: readonly RelPath[],
): CochangeSignificance {
  const diff = new Set(diffFiles);
  const touchesDiff = (a: RelPath, b: RelPath) => diff.has(a) || diff.has(b);
  return {
    summary: full.summary,
    admits: (a, b) => (touchesDiff(a, b) ? query.admits(a, b) : full.admits(a, b)),
    expectedSupport: (a, b) => (touchesDiff(a, b) ? query.expectedSupport(a, b) : full.expectedSupport(a, b)),
  };
}

function isLiveSubject(changeSubject: ArchitectureChangeSubject): changeSubject is ArchitectureTouchedActiveSubject {
  return changeSubject.tier === "active" || changeSubject.tier === "critical";
}

function canonicalFindingKey(finding: DiffDetectorFinding, renamedFrom?: ReadonlyMap<string, string>): string {
  return diffDetectorFindingKey({
    ...finding,
    endpoints: withCanonicalPaths(finding.endpoints, renamedFrom),
  } as DiffDetectorFinding);
}
