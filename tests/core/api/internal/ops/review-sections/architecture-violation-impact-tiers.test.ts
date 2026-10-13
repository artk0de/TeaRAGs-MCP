/**
 * The review-side impact tiers (bd tea-rags-mcp-r8hme.53 T2): each diff
 * finding carries the tier of the report violation it is — the overlaid run's
 * for an introduced one, the base run's for one that persists — and a
 * persisting active/critical violation the diff touches leaves the collapsed
 * list for `touchedActive`.
 */
import { describe, expect, it } from "vitest";

import { measureArchitectureViolationDelta } from "../../../../../../src/core/api/internal/ops/architecture-violation-delta.js";
import {
  ArchitectureViolationTierLookup,
  composeReviewCochangeSignificance,
  separateTouchedActiveViolations,
  stampDiffFindingImpactTiers,
} from "../../../../../../src/core/api/internal/ops/review-sections/architecture-violation-impact-tiers.js";
import type {
  ArchitectureViolation,
  ArchitectureViolationImpactTier,
  StableDependencyArchitectureViolation,
} from "../../../../../../src/core/contracts/types/architecture-report.js";
import type { DiffDetectorFinding } from "../../../../../../src/core/contracts/types/diff-detector-finding.js";
import type { CochangeSignificance } from "../../../../../../src/core/domains/trajectory/codegraph/temporal/index.js";

function sdp(source: string, target: string, tier?: ArchitectureViolationImpactTier): ArchitectureViolation {
  const violation: StableDependencyArchitectureViolation = {
    detector: "stableDependencies",
    sourceComponent: source,
    targetComponent: target,
    evidence: {
      sourceInstability: 0.2,
      targetInstability: 0.8,
      instabilityDelta: 0.6,
      sourceAfferentCount: 4,
      sourceEfferentCount: 1,
      targetAfferentCount: 1,
      targetEfferentCount: 4,
      callWeight: 1,
      directoryRelation: "disjoint",
      fileEdgeCount: 1,
      fileEdges: [{ sourceRelPath: `${source}/a.ts`, targetRelPath: `${target}/b.ts`, callWeight: 1 }],
    },
  };
  return tier === undefined ? violation : { ...violation, tier };
}

function sdpFinding(source: string, target: string): DiffDetectorFinding {
  return {
    subject: `${source} → ${target}`,
    detail: "d",
    detector: "stableDependencies",
    endpoints: {
      kind: "componentEdge",
      sourceComponent: source,
      targetComponent: target,
      sourceRelPath: `${source}/x.ts`,
      targetRelPath: `${target}/y.ts`,
    },
    evidence: { sourceInstability: 0.1, targetInstability: 0.9 },
  };
}

function cycleFinding(source: string, target: string): DiffDetectorFinding {
  return {
    subject: `${source} → ${target}`,
    detail: "d",
    detector: "cycles",
    endpoints: { kind: "fileEdge", sourceRelPath: source, targetRelPath: target },
    evidence: { path: [source, target, source] },
  };
}

function significanceAdmitting(...pairs: [string, string][]): CochangeSignificance {
  const admitted = new Set(pairs.map(([a, b]) => [a, b].sort().join("\0")));
  return {
    summary: {
      method: "poissonConfigurationNull",
      family: "full",
      q: 0.05,
      familySize: 1,
      testedPairCount: 1,
      admittedPairCount: admitted.size,
    },
    admits: (a, b) => admitted.has([a, b].sort().join("\0")),
    expectedSupport: () => 0.5,
  };
}

describe("stampDiffFindingImpactTiers", () => {
  it("carries the overlaid run's tier onto an introduced finding and the base run's onto a persisting one", () => {
    const base = [sdp("src/p", "src/q", "structural")];
    const overlaid = [sdp("src/p", "src/q", "active"), sdp("src/a", "src/b", "critical")];
    const delta = measureArchitectureViolationDelta(base, overlaid);

    const stamped = stampDiffFindingImpactTiers(
      [sdpFinding("src/a", "src/b"), sdpFinding("src/p", "src/q")],
      new ArchitectureViolationTierLookup(base, delta),
    );

    expect(stamped.map((f) => f.tier)).toEqual(["critical", "structural"]);
  });

  it("leaves a finding with no report counterpart, or an untiered one, without a tier", () => {
    const base = [sdp("src/p", "src/q")];
    const delta = measureArchitectureViolationDelta(base, base);

    const stamped = stampDiffFindingImpactTiers(
      [cycleFinding("src/a.ts", "src/b.ts"), sdpFinding("src/p", "src/q"), sdpFinding("src/x", "src/y")],
      new ArchitectureViolationTierLookup(base, delta),
    );

    for (const finding of stamped) expect(finding).not.toHaveProperty("tier");
  });
});

describe("separateTouchedActiveViolations", () => {
  const touchedArgs = (
    base: ArchitectureViolation[],
    persisting: { family: "stableDependencies"; subject: string; tier?: ArchitectureViolationImpactTier }[],
    findings: DiffDetectorFinding[],
    changedFiles: string[],
  ) => ({
    persisting,
    findings,
    tiers: new ArchitectureViolationTierLookup(base, measureArchitectureViolationDelta(base, base)),
    changedFiles,
    carrierFilesOf: (violation: object) =>
      (violation as StableDependencyArchitectureViolation).evidence.fileEdges.flatMap((e) => [
        e.sourceRelPath,
        e.targetRelPath,
      ]),
  });

  it("moves a collapsed active or critical entry to touchedActive and keeps a structural one collapsed", () => {
    const persisting = [
      { family: "stableDependencies" as const, subject: "src/p → src/q", tier: "active" as const },
      { family: "stableDependencies" as const, subject: "src/m → src/n", tier: "structural" as const },
    ];
    const base = [sdp("src/p", "src/q", "active"), sdp("src/m", "src/n", "structural")];

    const split = separateTouchedActiveViolations(
      touchedArgs(base, persisting, [sdpFinding("src/p", "src/q"), sdpFinding("src/m", "src/n")], ["src/p/x.ts"]),
    );

    expect(split.touchedActive).toEqual([{ family: "stableDependencies", subject: "src/p → src/q", tier: "active" }]);
    expect(split.persisting).toEqual([persisting[1]]);
  });

  it("surfaces a persisting active violation no finding names when a changed file is on its carrier edges", () => {
    const base = [
      sdp("src/p", "src/q", "critical"),
      sdp("src/u", "src/v", "active"),
      sdp("src/m", "src/n", "structural"),
    ];

    const split = separateTouchedActiveViolations(touchedArgs(base, [], [], ["src/p/a.ts", "src/m/a.ts"]));

    expect(split.touchedActive).toEqual([{ family: "stableDependencies", subject: "src/p → src/q", tier: "critical" }]);
    expect(split.persisting).toEqual([]);
  });
});

describe("composeReviewCochangeSignificance", () => {
  it("judges a pair touching the diff by the query family and any other pair by the full family", () => {
    const full = significanceAdmitting(["src/a.ts", "src/b.ts"], ["src/c.ts", "src/d.ts"]);
    const query = significanceAdmitting(["src/x.ts", "src/c.ts"]);

    const composed = composeReviewCochangeSignificance(full, query, ["src/a.ts", "src/x.ts"]);

    // Touching the diff: the full family's admission does not count — the diff's commits may carry it.
    expect(composed.admits("src/a.ts", "src/b.ts")).toBe(false);
    expect(composed.admits("src/c.ts", "src/x.ts")).toBe(true);
    // Off the diff: the full family decides.
    expect(composed.admits("src/d.ts", "src/c.ts")).toBe(true);
  });
});
