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

import type { CochangeFileLineCounts, RelPath } from "../../../../../../../src/core/contracts/types/codegraph.js";
import {
  classifyShotgunSurgeryMechanicalBundles,
  cochangeStrength,
  compoundPoissonUpperTailBound,
  detectShotgunSurgery,
  findShotgunSurgeryEchoPairs,
  poissonUpperTail,
  SHOTGUN_SURGERY_ECHO_EXACT_PERMUTATIONS,
  SHOTGUN_SURGERY_ECHO_EXCEEDANCES,
  shotgunSurgeryEchoPermutationPValue,
  shotgunSurgeryFamilySize,
  shotgunSurgeryMirroredNetShare,
  shotgunSurgeryModalUniformityPValue,
  type ShotgunSurgeryInput,
} from "../../../../../../../src/core/domains/trajectory/codegraph/temporal/index.js";
import { binomialUpperTail, mulberry32 } from "../../../../../../../src/core/infra/statistics/index.js";

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

describe("compoundPoissonUpperTailBound", () => {
  it("bounds the Poisson upper tail from above, within a small factor, when every weight is 1", () => {
    for (const lambda of [1e-6, 1e-3, 0.1, 2]) {
      for (const observed of [2, 3, 6]) {
        const exact = poissonUpperTail(observed, lambda);
        const bound = compoundPoissonUpperTailBound(observed, [{ weight: 1, mean: lambda }]);
        expect(bound).toBeGreaterThanOrEqual(exact);
        expect(bound).toBeLessThanOrEqual(Math.min(1, 10 * exact));
      }
    }
  });

  it("is 1 at or below the expected weighted sum", () => {
    expect(compoundPoissonUpperTailBound(0.5, [{ weight: 0.25, mean: 2 }])).toBe(1);
    expect(compoundPoissonUpperTailBound(0, [])).toBe(1);
  });

  it("prices a sum of tiny weights by the chance of one heavy event, not by their count", () => {
    // 0.01 needs one weight-1 event (mean 1e-3) or ten weight-0.001 events (mean 1e-3 each way).
    const p = compoundPoissonUpperTailBound(0.01, [
      { weight: 1, mean: 1e-3 },
      { weight: 0.001, mean: 1e-3 },
    ]);
    expect(p).toBeGreaterThanOrEqual(1 - Math.exp(-1e-3));
    expect(p).toBeLessThan(0.05);
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

  it("joins one task's commits across bursts into one logical change, counted once", () => {
    // TD-7 held the spread in two bursts a day apart: one task, one change.
    const bursts = [
      [{ components: ["a", "b", "c"], taskIds: ["TD-7"] }],
      [{ components: ["a", "b", "c"], taskIds: ["TD-7"] }],
      [{ components: ["a", "b", "c"], taskIds: ["TD-8"] }],
      [{ components: ["a", "b", "c"], taskIds: ["TD-9"] }],
    ];
    const report = detectShotgunSurgery({
      ...logicalHistory(background(["a", "b", "c"]), bursts),
      componentDependencies: [],
    });

    expect(report.findings.map((f) => `${f.components.join(",")}@${f.support}`)).toEqual(["a,b,c@3"]);
    // The TD-7 change is both of its commits, newest first.
    expect(report.findings[0].sampleChanges).toEqual([["b3c0"], ["b2c0"], ["b1c0", "b0c0"]]);
  });

  it("lets no umbrella task id join — an upper outlier of the ids' own breadth", () => {
    // Ordinary ids: each names one or two companions (2 or 3 distinct ids on
    // its commits). EPIC rides on nine sub-tasks' commits — 10 distinct ids,
    // above the Tukey fence over log2 of that breadth (cut 5 here).
    const ordinary: LogicalCommit[][] = [
      ...Array.from({ length: 6 }, (_, i) => [{ components: [`p${i}`], taskIds: [`P-${i}`, `Q-${i}`] }]),
      ...Array.from({ length: 4 }, (_, i) => [{ components: [`r${i}`], taskIds: [`R-${i}`, `S-${i}`, `U-${i}`] }]),
    ];
    const epic: LogicalCommit[][] = Array.from({ length: 9 }, (_, j) => [
      { components: j < 3 ? ["a", "b", "c"] : [`sub${j}`], taskIds: ["EPIC-1", `SUB-${j}`] },
    ]);
    const report = detectShotgunSurgery({
      ...logicalHistory(background(["a", "b", "c"]), [...ordinary, ...epic]),
      componentDependencies: [],
    });

    expect(report.summary.umbrellaTaskIdCut).toBe(5);
    expect(report.summary.umbrellaTaskIdCount).toBe(1);
    // Three sub-tasks held the spread: three changes, never one EPIC blob.
    expect(report.findings.map((f) => `${f.components.join(",")}@${f.support}`)).toEqual(["a,b,c@3"]);
  });

  it("weighs a change beyond the typical width T by its specificity, C(T, k) / C(width, k)", () => {
    // Twenty three-component changes of their own make T = 3 (the Tukey
    // fence over the widths). Two changes held exactly {a, b, c}; a third
    // held it inside five components: C(3, 3) / C(5, 3) = 1/10.
    const narrow = Array.from({ length: 20 }, (_, i) => [`n${i}x`, `n${i}y`, `n${i}z`]);
    const report = detectShotgunSurgery({
      ...history([
        ...background(["a", "b", "c"]),
        ...narrow,
        ["a", "b", "c"],
        ["a", "b", "c"],
        ["a", "b", "c", "w1", "w2"],
      ]),
      componentDependencies: [],
    });

    expect(report.summary.typicalChangeWidth).toBe(3);
    const [finding] = report.findings;
    expect(finding.components).toEqual(["a", "b", "c"]);
    expect(finding.support).toBe(3);
    expect(finding.weightedSupport).toBeCloseTo(1 + 1 + 1 / 10, 10);
  });

  it("counts a change within the typical width whole", () => {
    const report = detectShotgunSurgery({
      ...history([...background(["a", "b", "c"]), ["a", "b", "c", "w1"], ["a", "b", "c", "w2"], ["a", "b", "c", "w3"]]),
      componentDependencies: [],
    });

    expect(report.summary.typicalChangeWidth).toBeGreaterThanOrEqual(4);
    expect(report.findings[0].weightedSupport).toBe(3);
  });

  it("does not admit a triple only wide sweeps held, where narrow changes make specific evidence cheap", () => {
    // a, b and c each change alone twenty times, and 400 narrow changes of
    // their own (3–12 components) fill the history: one specific co-change of
    // a, b and c is a modest event. Two 80-component sweeps that happened to
    // include them weigh 2 · C(T, 3) / C(80, 3) — far less than one such change.
    const lone = Array.from({ length: 20 }, () => [["a"], ["b"], ["c"]]).flat();
    const narrow = Array.from({ length: 400 }, (_, i) => Array.from({ length: 3 + (i % 10) }, (_, j) => `n${i}_${j}`));
    const sweep = (s: number) => ["a", "b", "c", ...Array.from({ length: 77 }, (_, i) => `sweep${s}_${i}`)];
    const swept = detectShotgunSurgery({
      ...history([...background([]), ...lone, ...narrow, sweep(0), sweep(1)]),
      componentDependencies: [],
    });
    const specific = detectShotgunSurgery({
      ...history([...background([]), ...lone, ...narrow, ["a", "b", "c"], ["a", "b", "c"]]),
      componentDependencies: [],
    });

    expect(swept.summary.candidateSetCount).toBe(1);
    expect(swept.summary.admittedSetCount).toBe(0);
    expect(specific.summary.admittedSetCount).toBe(1);
  });

  it("explains siblings of one feature subtree that a typical change covers whole", () => {
    // The only multi-component changes are the three spreads: T = 4. The
    // subtree `page` holds 4 changed components — one typical change can
    // edit all of it, so its children are one feature, dependent by
    // construction, and their co-change is no shotgun surgery.
    const spread = ["page/a", "page/b", "page/c", "page/d"];
    const report = detectShotgunSurgery({
      ...history([...background(spread), spread, spread, spread]),
      componentDependencies: [],
    });

    expect(report.summary.typicalChangeWidth).toBe(4);
    expect(report.findings).toEqual([]);
    expect(report.explained.map((s) => s.islands)).toEqual([[spread]]);
    expect(report.summary.violationCount).toBe(0);
  });

  it("keeps siblings apart when their common subtree is wider than a typical change", () => {
    // Same spread, but `page` also holds five components changed alone: 9
    // changed components under it, more than T = 4 — no one change covers
    // the subtree, so sharing it is no evidence of one feature.
    const spread = ["page/a", "page/b", "page/c", "page/d"];
    const others = ["page/e", "page/f", "page/g", "page/h", "page/i"];
    const report = detectShotgunSurgery({
      ...history([...background([...spread, ...others]), spread, spread, spread]),
      componentDependencies: [],
    });

    expect(report.summary.typicalChangeWidth).toBe(4);
    expect(report.findings.map((f) => f.islands)).toEqual([spread.map((c) => [c])]);
  });

  it("groups namespace and directory components by their own trees, never across them", () => {
    // `::Billing` and `billing` each hold two changed components, inside
    // T = 4; a namespace and a directory share no ancestor, so the backend
    // and frontend halves stay two islands and the spread is still reported.
    const spread = ["::Billing::Charges", "::Billing::Refunds", "billing/form", "billing/table"];
    const report = detectShotgunSurgery({
      ...history([...background(spread), spread, spread, spread]),
      componentDependencies: [],
    });

    expect(report.findings.map((f) => f.islands)).toEqual([
      [
        ["::Billing::Charges", "::Billing::Refunds"],
        ["billing/form", "billing/table"],
      ],
    ]);
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

/** One commit's partitioned rows: component, file name, and its (added, deleted) lines — absent = not recorded. */
interface LineCommit {
  sha: string;
  rows: readonly (readonly [component: string, file: string, counts?: readonly [added: number, deleted: number]])[];
  taskIds?: readonly string[];
  /** The author burst; default = a burst of its own. */
  burst?: number;
}

/**
 * `lead` one-commit bursts (as {@link history}) whose every file carries a
 * distinct addition-only line count — no (added, deleted) key shared, no
 * deletion — followed by `commits`, one bundle each, in order.
 */
function lineHistory(lead: readonly (readonly string[])[], commits: readonly LineCommit[]): ShotgunSurgeryInput {
  const base = history(lead);
  const bundles = new Map(base.bundles);
  const bundleBursts = new Map(base.bundleBursts);
  const bundleCommits = new Map(base.bundleCommits);
  const bundleTaskIds = new Map<number, readonly string[]>([...base.bundles.keys()].map((id) => [id, []]));
  const componentOf = new Map(base.componentOf);
  const bundleFileLines = new Map<number, Map<RelPath, CochangeFileLineCounts>>();
  for (const [id, files] of base.bundles) {
    bundleFileLines.set(id, new Map(files.map((relPath, i) => [relPath, { added: 1000 * (id + 1) + i, deleted: 0 }])));
  }
  commits.forEach(({ sha, rows, taskIds = [], burst }, j) => {
    const id = lead.length + j;
    const files: RelPath[] = [];
    const lines = new Map<RelPath, CochangeFileLineCounts>();
    for (const [component, file, counts] of rows) {
      const relPath = fileOf(component, file);
      files.push(relPath);
      componentOf.set(relPath, component);
      if (counts) lines.set(relPath, { added: counts[0], deleted: counts[1] });
    }
    bundles.set(id, files);
    bundleBursts.set(id, burst ?? 10_000 + j);
    bundleCommits.set(id, [sha]);
    bundleTaskIds.set(id, taskIds);
    bundleFileLines.set(id, lines);
  });
  return {
    componentOf,
    componentDependencies: [],
    bundles,
    bundleBursts,
    bundleCommits,
    bundleTaskIds,
    bundleFileLines,
  };
}

/** `files` files in each of `components`, each row's counts from `counts(rowIndex)`. */
function rowsOver(
  components: readonly string[],
  files: number,
  counts: (row: number) => readonly [number, number],
  prefix = "f",
): LineCommit["rows"] {
  const rows: [string, string, readonly [number, number]][] = [];
  for (const component of components) {
    for (let f = 0; f < files; f++) rows.push([component, `${prefix}${f}`, counts(rows.length)]);
  }
  return rows;
}

/** The same input with no line counts recorded. */
function withoutLines(input: ShotgunSurgeryInput): ShotgunSurgeryInput {
  const { bundleFileLines: _lines, ...rest } = input;
  return rest;
}

/** 49 single-component commits of 12 files each, every row a distinct key: 588 rows that make no sweep. */
const MECHANICAL_CORPUS: LineCommit[] = Array.from({ length: 49 }, (_, j) => ({
  sha: `corpus${j}`,
  rows: rowsOver([`corpus${j}`], 12, (row) => [100_000 + 100 * j + row, 0]),
}));

describe("classifyShotgunSurgeryMechanicalBundles", () => {
  it("calls a commit mechanical when one (added, deleted) pair repeats over all its files beyond chance", () => {
    // 12 rows of (1, 1) among 600: the pair's corpus share is 0.02.
    const input = lineHistory([], [...MECHANICAL_CORPUS, { sha: "sweep", rows: rowsOver(SPREAD, 3, () => [1, 1]) }]);
    const classification = classifyShotgunSurgeryMechanicalBundles(input);

    expect([...classification.bundleIds]).toEqual([49]);
    expect(classification.testedCount).toBe(1);
    expect(detectShotgunSurgery(input).summary).toMatchObject({ mechanicalTestedCount: 1, mechanicalCommitCount: 1 });
  });

  it("does not call a commit of the same width mechanical when its line counts vary", () => {
    const input = lineHistory(
      [],
      [...MECHANICAL_CORPUS, { sha: "feature", rows: rowsOver(SPREAD, 3, (row) => [row + 1, row]) }],
    );
    const classification = classifyShotgunSurgeryMechanicalBundles(input);

    expect(classification.bundleIds.size).toBe(0);
    expect(classification.testedCount).toBe(1);
  });

  it("tests no commit with fewer than 3 line-counted files or fewer than 3 components", () => {
    const input = lineHistory(
      [],
      [
        ...MECHANICAL_CORPUS,
        // Four components, two of their files counted.
        {
          sha: "sparse",
          rows: [
            ["a", "f", [1, 1]],
            ["b", "f", [1, 1]],
            ["c", "f"],
            ["d", "f"],
          ],
        },
        // Twelve uniform rows over two components.
        { sha: "narrow", rows: rowsOver(["a", "b"], 6, () => [1, 1]) },
      ],
    );
    const classification = classifyShotgunSurgeryMechanicalBundles(input);

    expect(classification.bundleIds.size).toBe(0);
    expect(classification.testedCount).toBe(0);
  });

  it("never calls a bundle without recorded line counts mechanical", () => {
    const input = lineHistory([], [...MECHANICAL_CORPUS, { sha: "sweep", rows: rowsOver(SPREAD, 3, () => [1, 1]) }]);
    const lines = new Map(input.bundleFileLines);
    lines.delete(49);
    const classification = classifyShotgunSurgeryMechanicalBundles({ ...input, bundleFileLines: lines });

    expect(classification.bundleIds.size).toBe(0);
    expect(classification.testedCount).toBe(0);
  });
});

describe("shotgunSurgeryModalUniformityPValue", () => {
  it("is 1 when no key repeats", () => {
    expect(shotgunSurgeryModalUniformityPValue(12, 1, [0.5, 0.5])).toBe(1);
    expect(shotgunSurgeryModalUniformityPValue(12, 0, [1])).toBe(1);
  });

  it("bounds the full union sum from above when it stops early over many tiny shares", () => {
    const shares = [0.3, 0.1, ...Array.from({ length: 6000 }, () => 0.6 / 6000)].sort((a, b) => b - a);
    const full = shares.reduce((sum, share) => sum + binomialUpperTail(5, 12, share), 0);
    const bound = shotgunSurgeryModalUniformityPValue(12, 5, shares);

    expect(bound).toBeGreaterThanOrEqual(full);
    expect(bound).toBeLessThan(full * 1.001);
  });
});

describe("detectShotgunSurgery — mechanical commits", () => {
  it("drops mechanical commits from the support, so two sweeps and one change are no recurrence", () => {
    const input = lineHistory(background(SPREAD), [
      { sha: "change", rows: SPREAD.map((c, i) => [c, "f", [i + 1, 0]] as const) },
      { sha: "sweep1", rows: SPREAD.map((c) => [c, "s", [1, 1]] as const) },
      { sha: "sweep2", rows: SPREAD.map((c) => [c, "s", [1, 1]] as const) },
    ]);

    const kept = detectShotgunSurgery(withoutLines(input));
    expect(kept.findings.map((f) => `${f.components.join(",")}@${f.support}`)).toEqual(["a,b,c,d@3"]);
    const report = detectShotgunSurgery(input);
    expect(report.summary.mechanicalCommitCount).toBe(2);
    expect(report.findings).toEqual([]);
  });

  it("keeps the null of the counted history: sweeps elsewhere leave an unrelated spread's expectation unchanged", () => {
    const spreads = [0, 1, 2].map((s) => ({
      sha: `spread${s}`,
      rows: rowsOver(SPREAD, 1, (row) => [500 * (s + 1) + row, 0]),
    }));
    const sweeps = Array.from({ length: 30 }, (_, j) => ({
      sha: `sweep${j}`,
      rows: rowsOver(["x0", "x1", "x2", "x3"], 1, () => [j + 1, j + 1], "s"),
    }));
    const withSweeps = detectShotgunSurgery(lineHistory(background(SPREAD), [...spreads, ...sweeps]));
    const deleted = detectShotgunSurgery(lineHistory(background(SPREAD), spreads));

    expect(withSweeps.summary.mechanicalCommitCount).toBe(30);
    expect(withSweeps.findings).toHaveLength(1);
    expect(withSweeps.findings[0].expectedSupport).toBe(deleted.findings[0].expectedSupport);
    expect(withSweeps.findings).toEqual(deleted.findings);
    // Kept, the sweeps would have moved the null.
    const kept = detectShotgunSurgery(withoutLines(lineHistory(background(SPREAD), [...spreads, ...sweeps])));
    expect(kept.findings.find((f) => f.components.join() === SPREAD.join())?.expectedSupport).not.toBe(
      deleted.findings[0].expectedSupport,
    );
  });

  it("joins a task's other commits when one of them is mechanical, leaving the sweep out", () => {
    const commits: LineCommit[] = [0, 1, 2].flatMap((b) => [
      {
        sha: `b${b}c0`,
        rows: [
          ["a", "x", [10 * b + 1, 0]],
          ["b", "x", [10 * b + 2, 0]],
        ] as const,
        taskIds: [`TD-${b}`],
        burst: b,
      },
      { sha: `b${b}c1`, rows: [["c", "y", [10 * b + 3, 0]]] as const, taskIds: [`TD-${b}`], burst: b },
    ]);
    commits.push({ sha: "sweep", rows: rowsOver(["p", "q", "r"], 3, () => [1, 1]), taskIds: ["TD-2"], burst: 2 });
    const input = lineHistory(background(["a", "b", "c"]), commits);

    const report = detectShotgunSurgery(input);
    expect(report.summary.mechanicalCommitCount).toBe(1);
    expect(report.findings.map((f) => f.components)).toEqual([["a", "b", "c"]]);
    expect(report.findings[0].sampleChanges).toEqual([
      ["b2c1", "b2c0"],
      ["b1c1", "b1c0"],
      ["b0c1", "b0c0"],
    ]);
    expect(detectShotgunSurgery(withoutLines(input)).findings[0].sampleChanges[0]).toContain("sweep");
  });

  it("reads an empty line-count map as not recorded — the store's answer for a build before migration 046", () => {
    const input = { ...history([...background(SPREAD), SPREAD, SPREAD, SPREAD]), componentDependencies: [] };

    expect(detectShotgunSurgery({ ...input, bundleFileLines: new Map() })).toEqual(detectShotgunSurgery(input));
  });

  it("matches the report without line counts byte for byte, with no mechanical or echo summary fields", () => {
    const report = detectShotgunSurgery({
      ...history([...background(SPREAD), SPREAD, SPREAD, SPREAD]),
      componentDependencies: [],
    });

    expect(report.findings.map((f) => [f.support, f.weightedSupport, f.expectedSupport, f.strength])).toEqual([
      [3, 3, 0.029184959375878016, 0.30063605244263664],
    ]);
    expect(report.summary).toEqual({
      burstCount: 37,
      unitCount: 37,
      umbrellaTaskIdCount: 0,
      typicalChangeWidth: 4,
      wideUnitCount: 3,
      widthThreshold: 3,
      widthThresholdMethod: "otsu",
      widthSeparability: 0.9999999999999993,
      candidateSetCount: 4,
      familySize: 4,
      q: 0.05,
      admittedSetCount: 4,
      spreadCount: 1,
      explainedCount: 0,
      violationCount: 1,
      sharedNeighbourThresholdMethod: "none",
    });
  });
});

/** Ten files over SPREAD: a and b three each, c and d two each. */
const ECHO_FILES: readonly (readonly [string, string])[] = [
  ["a", "e0"],
  ["a", "e1"],
  ["a", "e2"],
  ["b", "e0"],
  ["b", "e1"],
  ["b", "e2"],
  ["c", "e0"],
  ["c", "e1"],
  ["d", "e0"],
  ["d", "e1"],
];
const ECHO_ADDED = [5, 9, 2, 7, 11, 3, 8, 4, 6, 10];

/** A flag added over eight files, removed with a few lines kept per file, and one unrelated change of the spread. */
function flagHistory(): ShotgunSurgeryInput {
  const added = [12, 3, 7, 1, 20, 5, 9, 2];
  const removed = [
    [1, 12],
    [0, 3],
    [2, 7],
    [0, 1],
    [3, 20],
    [0, 5],
    [1, 9],
    [0, 2],
  ] as const;
  // Two files in each of SPREAD's four components.
  const files = ECHO_FILES.filter(([, f]) => f !== "e2");
  return lineHistory(background(SPREAD), [
    { sha: "flag-add", rows: files.map(([c, f], i) => [c, f, [added[i], 0]] as const) },
    { sha: "other", rows: rowsOver(SPREAD, 1, (row) => [700 + row, 0], "h") },
    { sha: "flag-remove", rows: files.map(([c, f], i) => [c, f, removed[i]] as const) },
  ]);
}

describe("detectShotgunSurgery — echoes", () => {
  it("joins an exact revert to its original, so the spread they both held loses one change", () => {
    const input = lineHistory(background(SPREAD), [
      { sha: "original", rows: ECHO_FILES.map(([c, f], i) => [c, f, [ECHO_ADDED[i], 0]] as const) },
      { sha: "revert", rows: ECHO_FILES.map(([c, f], i) => [c, f, [0, ECHO_ADDED[i]]] as const) },
    ]);

    expect(detectShotgunSurgery(withoutLines(input)).findings.map((f) => f.support)).toEqual([2]);
    const report = detectShotgunSurgery(input);
    expect(report.summary.echoCandidatePairCount).toBe(1);
    expect(report.summary.echoPairCount).toBe(1);
    expect(report.findings).toEqual([]);
    expect(report.explained).toEqual([]);
  });

  it("does not join a follow-up that adds to the same files", () => {
    const input = lineHistory(background(SPREAD), [
      { sha: "feature", rows: ECHO_FILES.map(([c, f], i) => [c, f, [ECHO_ADDED[i], 0]] as const) },
      { sha: "follow-up", rows: ECHO_FILES.map(([c, f], i) => [c, f, [ECHO_ADDED[i] + 1, 1]] as const) },
    ]);
    const report = detectShotgunSurgery(input);

    expect(report.summary.echoCandidatePairCount).toBe(1);
    expect(report.summary.echoPairCount).toBe(0);
  });

  it("joins a flag removal to its addition as one change of the spread's support", () => {
    const report = detectShotgunSurgery(flagHistory());

    expect(report.summary.echoPairCount).toBe(1);
    expect(report.findings.map((f) => f.components)).toEqual([SPREAD]);
    expect(report.findings[0].sampleChanges).toEqual([["flag-remove", "flag-add"], ["other"]]);
  });

  it("never zeroes an echo: the original keeps its evidence, joined with its revert", () => {
    const flagged = flagHistory();
    expect(detectShotgunSurgery(withoutLines(flagged)).findings[0].support).toBe(3);
    expect(detectShotgunSurgery(flagged).findings[0].support).toBe(2);
  });

  it("decides the same whatever order the bundles arrive in, and the same on every run", () => {
    const input = flagHistory();
    const reversed = { ...input, bundles: new Map([...input.bundles].reverse()) };

    expect(detectShotgunSurgery(reversed)).toEqual(detectShotgunSurgery(input));
    expect(detectShotgunSurgery(input)).toEqual(detectShotgunSurgery(input));
  });

  it("never tests a pair touching a mechanical commit", () => {
    const input = lineHistory(
      [],
      [
        ...MECHANICAL_CORPUS,
        { sha: "sweep", rows: ECHO_FILES.map(([c, f]) => [c, f, [3, 0]] as const) },
        { sha: "cleanup", rows: ECHO_FILES.map(([c, f], i) => [c, f, [0, ECHO_ADDED[i]]] as const) },
      ],
    );
    const report = detectShotgunSurgery(input);

    expect(report.summary.mechanicalCommitCount).toBe(1);
    expect(report.summary.echoCandidatePairCount).toBe(0);
  });
});

describe("shotgunSurgeryMirroredNetShare", () => {
  it("is the opposite-sign overlap over the larger magnitude, 0 when both are empty", () => {
    expect(shotgunSurgeryMirroredNetShare([5, 3], [-5, -3])).toBe(1);
    expect(shotgunSurgeryMirroredNetShare([4, 2, 0], [-2, 2, 3])).toBeCloseTo(2 / 9, 15);
    expect(shotgunSurgeryMirroredNetShare([0, 0], [0, 0])).toBe(0);
    expect(shotgunSurgeryMirroredNetShare([], [])).toBe(0);
  });
});

describe("shotgunSurgeryEchoPermutationPValue", () => {
  const options = { exceedances: SHOTGUN_SURGERY_ECHO_EXCEEDANCES, maxPermutations: 1000 };

  /** A `random` that counts its calls. */
  function countingRandom(seed = 1): { random: () => number; calls: () => number } {
    let calls = 0;
    const next = mulberry32(seed);
    return {
      random: () => {
        calls++;
        return next();
      },
      calls: () => calls,
    };
  }

  it("is 1 without sampling when nothing is mirrored", () => {
    const rng = countingRandom();
    expect(shotgunSurgeryEchoPermutationPValue([5, 3, 2], [1, 4, 0], rng.random, options)).toBe(1);
    expect(rng.calls()).toBe(0);
  });

  it("enumerates every permutation exactly when the positions are few", () => {
    // Of the 4! = 24 assignments of {−2, −1, 0, 0}, only the two that keep
    // −2 and −1 in place (the zeros in either order) mirror whole.
    const rng = countingRandom();
    expect(shotgunSurgeryEchoPermutationPValue([2, 1, 0, 0], [-2, -1, 0, 0], rng.random, options)).toBe(2 / 24);
    expect(rng.calls()).toBe(0);
    expect(SHOTGUN_SURGERY_ECHO_EXACT_PERMUTATIONS).toBe(40_320);
  });

  it("stops sampling at exactly the requested exceedances (Besag–Clifford)", () => {
    // Every assignment of nine −1s mirrors nine +1s whole: each shuffle exceeds.
    const rng = countingRandom();
    const p = shotgunSurgeryEchoPermutationPValue(Array(9).fill(1), Array(9).fill(-1), rng.random, options);
    expect(p).toBe(1);
    // Fisher–Yates over nine positions draws eight numbers per shuffle.
    expect(rng.calls()).toBe(SHOTGUN_SURGERY_ECHO_EXCEEDANCES * 8);
  });

  it("floors at 1 / (cap + 1) when no shuffle reaches the observed mirror", () => {
    const rng = countingRandom();
    const first = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    const p = shotgunSurgeryEchoPermutationPValue(
      first,
      first.map((v) => -v),
      rng.random,
      { exceedances: SHOTGUN_SURGERY_ECHO_EXCEEDANCES, maxPermutations: 20 },
    );
    expect(p).toBe(1 / 21);
    expect(rng.calls()).toBe(20 * 8);
  });
});

describe("findShotgunSurgeryEchoPairs", () => {
  /** Two wide commits over the ten echo files, mirrored in part, under the given bundle ids. */
  function pairInput(ids: readonly [number, number]) {
    const first = [5, -3, 2, 7, -1, 4, 6, -2, 3, 1];
    const second = [-4, 2, 3, 1, -2, 5, -1, 3, 2, -3];
    const files = ECHO_FILES.map(([c, f]) => fileOf(c, f));
    const filesByComponent = new Map<string, Set<RelPath>>();
    ECHO_FILES.forEach(([c], i) => {
      const set = filesByComponent.get(c) ?? new Set<RelPath>();
      set.add(files[i]);
      filesByComponent.set(c, set);
    });
    const linesOf = (nets: readonly number[]) =>
      new Map(files.map((relPath, i) => [relPath, { added: Math.max(nets[i], 0), deleted: Math.max(-nets[i], 0) }]));
    return {
      commits: ids.map((bundleId) => ({ bundleId, filesByComponent })),
      input: {
        bundleFileLines: new Map([
          [ids[0], linesOf(first)],
          [ids[1], linesOf(second)],
        ]),
        bundleCommits: new Map([
          [ids[0], ["sha-first"]],
          [ids[1], ["sha-second"]],
        ]),
      },
    };
  }

  it("seeds each pair from its commits' SHAs, so renumbered bundles get the same p-values", () => {
    const a = pairInput([1, 2]);
    const b = pairInput([9, 4]);
    const before = findShotgunSurgeryEchoPairs(a.commits, a.input);
    const after = findShotgunSurgeryEchoPairs(b.commits, b.input);

    expect(before.candidatePairCount).toBe(1);
    expect(after.candidates.map((c) => c.pValue)).toEqual(before.candidates.map((c) => c.pValue));
    // A sampled p, neither the floor nor the no-mirror 1.
    expect(before.candidates[0].pValue).toBeGreaterThan(1 / 21);
    expect(before.candidates[0].pValue).toBeLessThan(1);
  });
});
