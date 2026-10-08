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
 *   - the BH family is every set of exactly k components among those changed
 *     in ≥ 2 bursts — C(n, k), the pair gate's C(|F₂|, 2) lifted to k; each
 *     observed k-set two bursts share is tested, the rest count with p = 1;
 *   - admitted k-sets merge into maximal spreads: a k-set's spread is the
 *     admitted k-sets inside the components EVERY one of its bursts touched,
 *     so k-sets recurring in the same bursts are one spread, and spreads that
 *     never co-occurred are never glued into a union no change touched;
 *   - a wide spread that recurs only because its components change in most
 *     bursts is not significant under the null — no hub cut needed;
 *   - the counting unit is the author burst: re-committing the spread inside
 *     one burst counts once;
 *   - a burst supports a k-set only when ONE of its commits held all k
 *     components — the pair gate's "a pair counts only when one commit held
 *     it", lifted to k; commits of one burst never chain into a union;
 *   - a spread's closure and sample commits are the commits that held its
 *     k-sets, never the rest of their bursts;
 *   - no bundle membership = nothing judged, never zeros posing as verdicts.
 */

import { describe, expect, it } from "vitest";

import type { RelPath } from "../../../../../../../src/core/contracts/types/codegraph.js";
import {
  cochangeStrength,
  detectShotgunSurgery,
  shotgunSurgeryFamilySize,
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

/**
 * One burst per entry, each burst a list of commits (one bundle each, commit
 * `b<burst>c<commit>`), appended after `lead` one-commit bursts.
 */
function burstHistory(
  lead: readonly (readonly string[])[],
  bursts: readonly (readonly (readonly string[])[])[],
): Pick<ShotgunSurgeryInput, "bundles" | "bundleBursts" | "bundleCommits" | "componentOf"> {
  const base = history(lead);
  const bundles = new Map(base.bundles);
  const bundleBursts = new Map(base.bundleBursts);
  const bundleCommits = new Map(base.bundleCommits);
  const componentOf = new Map(base.componentOf);
  let bundleId = bundles.size;
  bursts.forEach((commits, b) => {
    commits.forEach((components, c) => {
      bundles.set(
        bundleId,
        components.map((component) => fileOf(component)),
      );
      bundleBursts.set(bundleId, lead.length + b);
      bundleCommits.set(bundleId, [`b${b}c${c}`]);
      for (const component of components) componentOf.set(fileOf(component), component);
      bundleId++;
    });
  });
  return { bundles, bundleBursts, bundleCommits, componentOf };
}

/** One commit of a burst: the components it touched, through `file` (default `f`), and its message's task ids. */
interface LogicalCommit {
  components: readonly string[];
  file?: string;
  taskIds?: readonly string[];
}

/**
 * Like {@link burstHistory}, but each commit names the file it touched in
 * every component (so two commits share a file only when they name the same
 * one) and the task ids its message carried.
 */
function logicalHistory(
  lead: readonly (readonly string[])[],
  bursts: readonly (readonly LogicalCommit[])[],
): Pick<ShotgunSurgeryInput, "bundles" | "bundleBursts" | "bundleCommits" | "bundleTaskIds" | "componentOf"> {
  const base = history(lead);
  const bundles = new Map(base.bundles);
  const bundleBursts = new Map(base.bundleBursts);
  const bundleCommits = new Map(base.bundleCommits);
  const bundleTaskIds = new Map<number, readonly string[]>([...base.bundles.keys()].map((id) => [id, []]));
  const componentOf = new Map(base.componentOf);
  let bundleId = bundles.size;
  bursts.forEach((commits, b) => {
    commits.forEach(({ components, file = "f", taskIds = [] }, c) => {
      bundles.set(
        bundleId,
        components.map((component) => fileOf(component, file)),
      );
      bundleBursts.set(bundleId, lead.length + b);
      bundleCommits.set(bundleId, [`b${b}c${c}`]);
      bundleTaskIds.set(bundleId, taskIds);
      for (const component of components) componentOf.set(fileOf(component, file), component);
      bundleId++;
    });
  });
  return { bundles, bundleBursts, bundleCommits, bundleTaskIds, componentOf };
}

/** 30 single-component changes of distinct filler components, plus one lone change to each of `lone`. */
function background(lone: readonly string[]): string[][] {
  return [...Array.from({ length: 30 }, (_, i) => [`filler${i}`]), ...lone.map((c) => [c])];
}

const SPREAD = ["a", "b", "c", "d"];

describe("shotgunSurgeryFamilySize", () => {
  it("is C(n, k) — every set of exactly k components changed in ≥ 2 bursts", () => {
    expect(shotgunSurgeryFamilySize(5, 3)).toBe(10);
    expect(shotgunSurgeryFamilySize(40, 3)).toBe(9880);
    expect(shotgunSurgeryFamilySize(2, 3)).toBe(0);
  });
});

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
    // n = 4 components changed ≥ 2×, k = 3: the family is C(4, 3) = 4, and
    // each of its triples recurs in the three spreads — one maximal spread.
    expect(report.summary.familySize).toBe(4);
    expect(report.summary.admittedSetCount).toBe(4);
    expect(report.summary.spreadCount).toBe(1);
    expect(report.summary.violationCount).toBe(1);
    expect(report.summary.explainedCount).toBe(0);
  });

  it("tests every observed k-set against the C(n, k) family and merges the admitted ones into one maximal spread", () => {
    const spread = ["a", "b", "c", "d", "e"];
    const report = detectShotgunSurgery({
      ...history([...background(spread), spread, spread, spread]),
      componentDependencies: [],
    });

    expect(report.summary.widthThreshold).toBe(3);
    expect(report.summary.familySize).toBe(shotgunSurgeryFamilySize(5, 3));
    // All C(5, 3) = 10 triples recur in the same three bursts.
    expect(report.summary.candidateSetCount).toBe(10);
    expect(report.summary.admittedSetCount).toBe(10);
    expect(report.summary.spreadCount).toBe(1);
    expect(report.findings.map((f) => f.components)).toEqual([spread]);
    expect(report.findings[0].support).toBe(3);
  });

  it("keeps spreads recurring in different bursts apart, never gluing them into a union no change touched", () => {
    const left = ["a", "b", "c", "d"];
    const right = ["a", "b", "c", "e"];
    const report = detectShotgunSurgery({
      ...history([...background(["a", "b", "c", "d", "e"]), left, left, left, right, right, right]),
      componentDependencies: [],
    });

    const spreads = report.findings.map((f) => `${f.components.join(",")}@${f.support}`).sort();
    // {a,b,c} recurs in all six; {a,b,c,d} and {a,b,c,e} in three each;
    // {a,…,e} never co-occurred, so it is no spread.
    expect(spreads).toEqual(["a,b,c,d@3", "a,b,c,e@3", "a,b,c@6"]);
    expect(report.summary.spreadCount).toBe(3);
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

  it("gives no support to a k-set no single commit held, however its burst's commits chain", () => {
    // Each burst's commits touch two of {a, b, c} apiece; the burst's union is
    // all three, but no commit ever edited a, b and c together.
    const split = [
      ["a", "b"],
      ["b", "c"],
      ["a", "c"],
    ];
    const report = detectShotgunSurgery({
      ...burstHistory(background(["a", "b", "c"]), [split, split, split]),
      componentDependencies: [],
    });

    expect(report.summary.candidateSetCount).toBe(0);
    expect(report.summary.admittedSetCount).toBe(0);
    expect(report.findings).toEqual([]);
    expect(report.explained).toEqual([]);
  });

  it("counts a burst once when one of its commits held the k-set, however many did", () => {
    const report = detectShotgunSurgery({
      ...burstHistory(background(["a", "b", "c"]), [
        // Only the third commit held all three.
        [
          ["a", "b"],
          ["b", "c"],
          ["a", "b", "c"],
        ],
        // Four commits held all three: still one burst.
        [
          ["a", "b", "c"],
          ["a", "b", "c"],
          ["a", "b", "c"],
          ["a", "b", "c"],
        ],
        [["a", "b", "c"]],
      ]),
      componentDependencies: [],
    });

    expect(report.findings).toHaveLength(1);
    const [finding] = report.findings;
    expect(finding.components).toEqual(["a", "b", "c"]);
    expect(finding.support).toBe(3);
    // Each component: its lone change + the three bursts.
    expect(finding.componentChanges).toEqual([4, 4, 4]);
    // One commit per supporting burst, each one that held {a, b, c} — never
    // b0c0 / b0c1, which held two, and b1's re-commits do not crowd the rest.
    expect(finding.sampleCommits).toEqual(["b2c0", "b1c3", "b0c2"]);
    expect(report.summary.burstCount).toBe(36);
  });

  it("closes a spread over what the holding commits touched, not over the rest of their bursts", () => {
    // Every burst edits a, b and c in one commit and d in another: d belongs
    // to the bursts, never to a change that held the spread.
    const burst = [["a", "b", "c"], ["d"]];
    const report = detectShotgunSurgery({
      ...burstHistory(background(["a", "b", "c", "d"]), [burst, burst, burst]),
      componentDependencies: [],
    });

    expect(report.findings.map((f) => f.components)).toEqual([["a", "b", "c"]]);
    expect(report.findings[0].sampleCommits).toEqual(["b2c0", "b1c0", "b0c0"]);
  });

  it("joins a burst's commits sharing a task id into one change, however unlinked their files", () => {
    // Each burst: one commit edits a and b, another edits c through a
    // different file; both messages name the burst's task.
    const bursts = [0, 1, 2].map((b) => [
      { components: ["a", "b"], file: "x", taskIds: [`TD-${b}`] },
      { components: ["c"], file: "y", taskIds: [`TD-${b}`] },
    ]);
    const report = detectShotgunSurgery({
      ...logicalHistory(background(["a", "b", "c"]), bursts),
      componentDependencies: [],
    });

    expect(report.findings.map((f) => `${f.components.join(",")}@${f.support}`)).toEqual(["a,b,c@3"]);
    // One commit per supporting burst; the change behind it is both commits.
    expect(report.findings[0].sampleCommits).toEqual(["b2c1", "b1c1", "b0c1"]);
    expect(report.findings[0].sampleChanges).toEqual([
      ["b2c1", "b2c0"],
      ["b1c1", "b1c0"],
      ["b0c1", "b0c0"],
    ]);
  });

  it("lists each component's carrier files, most-touched first", () => {
    const bursts = [0, 1, 2].map((b) => [
      { components: ["a", "b", "c"], file: "x" },
      ...(b === 0 ? [{ components: ["a"], file: "y", taskIds: ["TD-9"] }] : []),
    ]);
    // Burst 0's second commit joins the first through the shared task id.
    bursts[0][0] = { ...bursts[0][0], taskIds: ["TD-9"] };
    const report = detectShotgunSurgery({
      ...logicalHistory(background(["a", "b", "c"]), bursts),
      componentDependencies: [],
    });

    const [finding] = report.findings;
    expect(finding.carrierFiles).toEqual([
      [fileOf("a", "x"), fileOf("a", "y")],
      [fileOf("b", "x")],
      [fileOf("c", "x")],
    ]);
    expect(finding.exemplarFiles).toEqual(finding.carrierFiles.map((files) => files[0]));
  });

  it("keeps commits apart whose files a file dependency links, when no task id joins them", () => {
    // Hub files and dense import edges chain whole bursts (measured: 0 -> 5
    // violations on tea-rags), so structure is no evidence of one change.
    const bursts = [0, 1, 2].map(() => [
      { components: ["a", "b"], file: "x" },
      { components: ["c"], file: "y" },
    ]);
    const report = detectShotgunSurgery({
      ...logicalHistory(background(["a", "b", "c"]), bursts),
      componentDependencies: [{ sourceComponent: "b", targetComponent: "c" }],
    });

    expect(report.findings).toEqual([]);
    expect(report.summary.candidateSetCount).toBe(0);
  });

  it("keeps commits apart that edited a common file, when no task id joins them", () => {
    const bursts = [0, 1, 2].map(() => [
      { components: ["a", "b"], file: "x" },
      { components: ["b", "c"], file: "x" },
    ]);
    const report = detectShotgunSurgery({
      ...logicalHistory(background(["a", "b", "c"]), bursts),
      componentDependencies: [],
    });

    expect(report.findings).toEqual([]);
    expect(report.summary.candidateSetCount).toBe(0);
  });

  it("keeps parallel commits of one burst apart when no task id joins them", () => {
    // Two agent sessions under one author: different tasks, unrelated files.
    const bursts = [0, 1, 2].map((b) => [
      { components: ["a", "b"], file: "x", taskIds: [`TD-${b}`] },
      { components: ["c"], file: "y", taskIds: [`AB-${b}`] },
    ]);
    const input = logicalHistory(background(["a", "b", "c"]), bursts);
    const report = detectShotgunSurgery({
      ...input,
      componentDependencies: [],
    });

    expect(report.summary.candidateSetCount).toBe(0);
    expect(report.findings).toEqual([]);
    // Both commits of every burst stay their own change.
    expect(report.summary.unitCount).toBe(input.bundles.size);
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
