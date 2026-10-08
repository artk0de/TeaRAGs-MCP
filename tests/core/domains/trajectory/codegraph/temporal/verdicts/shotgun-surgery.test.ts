/**
 * Shotgun surgery over the temporal co-change bundles (bd
 * tea-rags-mcp-r8hme.50): one change — an author burst — spread over N
 * components, recurring more often than the component-level configuration
 * null predicts, with no structural link explaining the spread.
 *
 * Invariants under test:
 *   - a recurring wide spread whose components nothing links is a finding,
 *     with its support, the null's expected support, Wilson strength, the
 *     unlinked islands, exemplar files and sample commits;
 *   - the same spread joined by an import chain is EXPLAINED, not a finding;
 *   - a specific shared neighbour (silent coupling's ln(N / fanIn) weight,
 *     Otsu-cut) joins two components the way a direct link does;
 *   - a wide spread that recurs only because its components change in most
 *     bursts is not significant under the null — no hub cut needed;
 *   - the counting unit is the author burst: re-committing the spread inside
 *     one burst counts once;
 *   - no bundle membership = nothing judged, never zeros posing as verdicts.
 */

import { describe, expect, it } from "vitest";

import type { RelPath } from "../../../../../../../src/core/contracts/types/codegraph.js";
import {
  cochangeStrength,
  detectShotgunSurgery,
  type ShotgunSurgeryInput,
} from "../../../../../../../src/core/domains/trajectory/codegraph/temporal/index.js";

/** Component `c` holds `src/<c>/*.ts`. */
function fileOf(component: string, name = "f"): RelPath {
  return `src/${component}/${name}.ts`;
}

/** One burst per entry, each burst one bundle of one commit `c<i>`. */
function history(
  bursts: readonly (readonly string[])[],
): Pick<ShotgunSurgeryInput, "bundles" | "bundleBursts" | "bundleCommits" | "componentOf"> {
  const bundles = new Map<number, RelPath[]>();
  const bundleBursts = new Map<number, number>();
  const bundleCommits = new Map<number, string[]>();
  const componentOf = new Map<RelPath, string>();
  bursts.forEach((components, i) => {
    bundles.set(
      i,
      components.map((c) => fileOf(c)),
    );
    bundleBursts.set(i, i);
    bundleCommits.set(i, [`c${i}`]);
    for (const c of components) componentOf.set(fileOf(c), c);
  });
  return { bundles, bundleBursts, bundleCommits, componentOf };
}

/** 30 single-component changes of distinct filler components, plus one lone change to each of `lone`. */
function background(lone: readonly string[]): string[][] {
  return [...Array.from({ length: 30 }, (_, i) => [`filler${i}`]), ...lone.map((c) => [c])];
}

const SPREAD = ["a", "b", "c", "d"];

describe("detectShotgunSurgery", () => {
  it("reports a recurring wide spread that no structural link explains", () => {
    const input = history([...background(SPREAD), SPREAD, SPREAD, SPREAD]);
    const report = detectShotgunSurgery({ ...input, componentDependencies: [] });

    expect(report.findings).toHaveLength(1);
    const [finding] = report.findings;
    expect(finding.components).toEqual(SPREAD);
    expect(finding.support).toBe(3);
    expect(finding.expectedSupport).toBeLessThan(1);
    // Each component changed 4 times (one lone change + the 3 spreads).
    expect(finding.strength).toBeCloseTo(
      cochangeStrength({ support: 3, confidenceAB: 3 / 4, confidenceBA: 3 / 4 }),
      10,
    );
    expect(finding.islands).toEqual([["a"], ["b"], ["c"], ["d"]]);
    expect(finding.exemplarFiles).toEqual(SPREAD.map((c) => fileOf(c)));
    expect(finding.sampleCommits).toEqual(["c36", "c35", "c34"]);
    expect(report.summary.widthThreshold).toBeGreaterThanOrEqual(3);
    expect(report.summary.admittedSetCount).toBe(1);
    expect(report.summary.violationCount).toBe(1);
    expect(report.summary.explainedCount).toBe(0);
  });

  it("explains the same spread when an import chain joins its components", () => {
    const input = history([...background(SPREAD), SPREAD, SPREAD, SPREAD]);
    const report = detectShotgunSurgery({
      ...input,
      componentDependencies: [
        { sourceComponent: "a", targetComponent: "b" },
        { sourceComponent: "b", targetComponent: "c" },
        { sourceComponent: "d", targetComponent: "c" },
      ],
    });

    expect(report.findings).toEqual([]);
    expect(report.explained).toHaveLength(1);
    expect(report.explained[0].islands).toEqual([SPREAD]);
    expect(report.summary.explainedCount).toBe(1);
    expect(report.summary.violationCount).toBe(0);
  });

  it("lets a specific shared neighbour join two components, a kernel everyone imports joins nothing", () => {
    const spread = ["a", "b", "c", "d", "e"];
    const input = history([...background(spread), spread, spread, spread]);
    const others = ["f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12"];
    const componentDependencies = [
      // a and b alone import the wire protocol `proto`.
      { sourceComponent: "a", targetComponent: "proto" },
      { sourceComponent: "b", targetComponent: "proto" },
      // every component imports the kernel.
      ...[...spread, ...others, "proto"].map((c) => ({ sourceComponent: c, targetComponent: "kernel" })),
    ];
    const report = detectShotgunSurgery({ ...input, componentDependencies });

    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].islands).toEqual([["a", "b"], ["c"], ["d"], ["e"]]);
    expect(report.summary.sharedNeighbourThresholdMethod).toBe("otsu");
  });

  it("does not report a wide spread frequent only because its components change in most bursts", () => {
    // Every on/off combination of a..d, three times over, each change also
    // touching two components of its own: a..d change independently, each
    // in half the bursts, so the full spread recurs exactly as often as
    // independence predicts.
    const bursts: string[][] = [];
    for (let round = 0; round < 3; round++) {
      for (let mask = 0; mask < 16; mask++) {
        const touched = SPREAD.filter((_, bit) => (mask >> bit) & 1);
        bursts.push([...touched, `own${round}_${mask}_x`, `own${round}_${mask}_y`]);
      }
    }
    const report = detectShotgunSurgery({ ...history(bursts), componentDependencies: [] });

    expect(report.summary.candidateSetCount).toBeGreaterThan(0);
    expect(report.findings).toEqual([]);
    expect(report.summary.admittedSetCount).toBe(0);
  });

  it("counts a spread re-committed inside one author burst once", () => {
    const input = history([...background(SPREAD), SPREAD, SPREAD, SPREAD]);
    // The second and third spreads are one author's burst.
    const bundleBursts = new Map(input.bundleBursts);
    bundleBursts.set(36, 35);
    const report = detectShotgunSurgery({ ...input, bundleBursts, componentDependencies: [] });

    expect(report.findings[0]?.support ?? 0).toBeLessThan(3);
    expect(report.summary.unitCount).toBe(input.bundles.size - 1);
  });

  it("judges nothing without bundle membership", () => {
    const report = detectShotgunSurgery({
      componentOf: new Map(),
      componentDependencies: [],
      bundles: new Map(),
    });

    expect(report.findings).toEqual([]);
    expect(report.explained).toEqual([]);
    expect(report.summary.unitCount).toBe(0);
    expect(report.summary.candidateSetCount).toBe(0);
  });

  it("keeps a finding in scope when one of its components' files matches the pattern", () => {
    const input = history([...background(SPREAD), SPREAD, SPREAD, SPREAD]);
    const inScope = detectShotgunSurgery({ ...input, componentDependencies: [], sourcePathPattern: "src/c/**" });
    const outOfScope = detectShotgunSurgery({ ...input, componentDependencies: [], sourcePathPattern: "src/z/**" });

    expect(inScope.findings).toHaveLength(1);
    expect(outOfScope.findings).toEqual([]);
    expect(outOfScope.summary.outOfScopeSetCount).toBe(1);
  });
});
