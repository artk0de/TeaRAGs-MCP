/**
 * Hub-like dependency (bd tea-rags-mcp-r8hme.47, Arcan's smell): a component
 * many depend on that itself depends on many. I = Ce / (Ca + Ce) sits near
 * 0.5, so SDP does not flag it and the main sequence may read it as healthy.
 * Verdict: Ca AND Ce both clear an adaptive cut drawn over the judged
 * component population (majority-floored Otsu on the log scale, the median as
 * the floor), behind the SDP connection-count floor, AND the component is
 * balanced — |Ca − Ce| / (Ca + Ce) below Arcan's 1/4.
 */
import { describe, expect, it } from "vitest";

import type {
  FileDependencyEdge,
  FileDependencyGraph,
} from "../../../../../../../src/core/contracts/types/codegraph.js";
import {
  buildComponentGraph,
  DEFAULT_SDP_MIN_CONNECTION_COUNT,
  detectHubLikeDependencies,
  HUB_LIKE_DEPENDENCY_EVIDENCE_LIMIT,
  HUB_LIKE_DEPENDENCY_MAX_IMBALANCE,
} from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/boundary-diagnostics/index.js";

function file(relPath: string) {
  return { relPath, language: "typescript", symbolCount: 1 };
}

function edge(sourceRelPath: string, targetRelPath: string, callWeight = 1): FileDependencyEdge {
  return { sourceRelPath, targetRelPath, callWeight };
}

/**
 * `hub/`        — 10 files importing all 8 sinks, plus `extraHubFiles` more
 *                 importing sink1 only; 40 dependents (src1..src8 × 5 files).
 *                 Default 30 extra: Ca 40, Ce 40, I 0.5 — a balanced hub.
 *                 0 extra: Ca 40, Ce 10, I 0.2 — busy but unbalanced.
 * `srcN/`       — 5 files each importing a hub file: Ca 0, Ce 5.
 * `sinkN/`      — imported by every hub file: Ca 10+, Ce 0.
 * `mid/`        — 3 dependents, 3 files depending outward: Ca 3, Ce 3, I 0.5 —
 *                 balanced, but no busier than the typical component.
 * `thin/`       — 2 dependents, 2 files depending outward: Ca + Ce 4, below the
 *                 connection floor.
 * `user/`       — 3 files into `mid/`, 2 into `thin/`: Ca 0, Ce 5.
 */
function graph(extraHubFiles = 30): FileDependencyGraph {
  const files = [];
  const edges: FileDependencyEdge[] = [];
  for (let s = 1; s <= 8; s++) files.push(file(`sink${s}/s.ts`));
  for (let h = 1; h <= 10; h++) {
    files.push(file(`hub/h${h}.ts`));
    for (let s = 1; s <= 8; s++) edges.push(edge(`hub/h${h}.ts`, `sink${s}/s.ts`, s));
  }
  for (let h = 11; h <= 10 + extraHubFiles; h++) {
    files.push(file(`hub/h${h}.ts`));
    edges.push(edge(`hub/h${h}.ts`, "sink1/s.ts"));
  }
  for (let c = 1; c <= 8; c++) {
    for (let f = 1; f <= 5; f++) {
      files.push(file(`src${c}/f${f}.ts`));
      edges.push(edge(`src${c}/f${f}.ts`, `hub/h${f}.ts`, c));
    }
  }
  for (let m = 1; m <= 3; m++) {
    files.push(file(`mid/m${m}.ts`), file(`user/u${m}.ts`));
    edges.push(edge(`mid/m${m}.ts`, "sink1/s.ts"), edge(`user/u${m}.ts`, `mid/m${m}.ts`));
  }
  for (let t = 1; t <= 2; t++) {
    files.push(file(`thin/t${t}.ts`), file(`user/v${t}.ts`));
    edges.push(edge(`thin/t${t}.ts`, "sink2/s.ts"), edge(`user/v${t}.ts`, `thin/t${t}.ts`));
  }
  return { files, edges };
}

function judge(g: FileDependencyGraph, options = {}) {
  return detectHubLikeDependencies(buildComponentGraph(g, []), options);
}

describe("detectHubLikeDependencies", () => {
  it("reports the component whose Ca and Ce both clear the adaptive cut, with its neighbours as evidence", () => {
    const report = judge(graph());

    expect(report.violations.map((v) => v.component)).toEqual(["hub"]);
    const [hub] = report.violations;
    expect(hub).toMatchObject({
      component: "hub",
      kind: "directory",
      facadeRelPath: null,
      afferentCount: 40,
      efferentCount: 40,
      instability: 0.5,
      fileCount: 40,
      dependentComponentCount: 8,
      dependencyComponentCount: 8,
      // src1..src8 reach the hub; user reaches mid and thin only.
      transitiveImpact: 8,
    });
    // Heaviest first: by file edges, then call weight, then path.
    expect(hub.topDependents).toHaveLength(HUB_LIKE_DEPENDENCY_EVIDENCE_LIMIT);
    expect(hub.topDependents[0]).toEqual({
      component: "src8",
      directoryRelation: "disjoint",
      fileEdgeCount: 5,
      callWeight: 40,
    });
    expect(hub.topDependencies[0]).toEqual({
      component: "sink1",
      directoryRelation: "disjoint",
      fileEdgeCount: 40,
      callWeight: 40,
    });
    expect(hub.churn).toBeUndefined();
  });

  // Owner decision 2026-10-08: without the balance condition both cuts fell to
  // the median on tea-rags and 16 of 60 components read as hubs, infra (I 0.06)
  // and language (I 0.97) among them — those are SDP's stable / unstable ends,
  // not the I ≈ 0.5 blind spot this detector exists for.
  it("does not flag a busy component whose coupling is lopsided, and counts it as imbalanced", () => {
    const report = judge(graph(0));
    expect(report.violations).toEqual([]);
    expect(report.summary.excluded.imbalanced).toBe(1); // hub: Ca 40, Ce 10 → 30/50 = 0.6
    expect(HUB_LIKE_DEPENDENCY_MAX_IMBALANCE).toBe(0.25);
  });

  // bd tea-rags-mcp-g77p3: a dependency into the measured foundation (the
  // pure-types kernel `foundationComponents` names) is not efferent coupling.
  // Ce counts the files with an edge into a NON-foundation component.
  it("does not count a file whose every dependency lands in the foundation toward the hub's Ce", () => {
    // sink1 the foundation: h11..h40 reach it alone and drop out → Ce 10,
    // Ca 40 → 30/50 = 0.6, lopsided.
    const report = judge(graph(), { foundationComponents: new Set(["sink1"]) });
    expect(report.violations).toEqual([]);
    expect(report.summary.excluded.imbalanced).toBe(1);
  });

  it("keeps a file in the hub's Ce while it still reaches one non-foundation component", () => {
    // sink8 the foundation: h1..h10 still reach sink1..sink7, h11..h40 sink1.
    const [hub] = judge(graph(), { foundationComponents: new Set(["sink8"]) }).violations;
    expect(hub).toMatchObject({ component: "hub", afferentCount: 40, efferentCount: 40 });
  });

  // bd tea-rags-mcp-g77p3 (owner decision): the efferent cut is drawn over
  // the components that depend on something — a Ce 0 leaf can never be a hub,
  // and a mass of them must not drag the median down.
  it("draws the efferent cut over non-leaf components only, so leaves never depress it", () => {
    // z1..z4: leaves (Ce 0). a, b, c: 12 files each into a leaf (Ce 12, Ca 0).
    // x: 9 files into z2 (Ce 9), imported by a1..a10 (Ca 10) — balanced, and
    // above the median of all judged Ce (4.5) but not the non-leaf one (12).
    const files = [...["z1", "z2", "z3", "z4"].map((z) => file(`${z}/z.ts`))];
    const edges: FileDependencyEdge[] = [];
    for (const [dir, leaf] of [
      ["a", "z1"],
      ["b", "z3"],
      ["c", "z4"],
    ]) {
      for (let i = 1; i <= 12; i++) {
        files.push(file(`${dir}/${dir}${i}.ts`));
        edges.push(edge(`${dir}/${dir}${i}.ts`, `${leaf}/z.ts`));
      }
    }
    for (let i = 1; i <= 9; i++) {
      files.push(file(`x/x${i}.ts`));
      edges.push(edge(`x/x${i}.ts`, "z2/z.ts"));
    }
    for (let i = 1; i <= 10; i++) edges.push(edge(`a/a${i}.ts`, `x/x${((i - 1) % 9) + 1}.ts`));

    const report = judge({ files, edges });
    expect(report.summary.judgedComponentCount).toBe(8);
    expect(report.summary.efferent).toMatchObject({ median: 12, threshold: 12 });
    expect(report.violations).toEqual([]);
  });

  it("does not flag a balanced component (I near 0.5) that is no busier than the typical component", () => {
    const report = judge(graph());
    expect(report.violations.some((v) => v.component === "mid")).toBe(false);
    // mid's Ca equals the median Ca: the floor is strict.
    expect(report.summary.afferent.median).toBe(3);
  });

  it("never judges a component below the SDP connection floor", () => {
    const report = judge(graph());
    expect(report.summary.minConnectionCount).toBe(DEFAULT_SDP_MIN_CONNECTION_COUNT);
    expect(report.summary.excluded.lowConnectionCount).toBe(1); // thin
    expect(report.summary.judgedComponentCount).toBe(report.summary.componentCount - 1);
    expect(report.violations.some((v) => v.component === "thin")).toBe(false);
  });

  it("summarises both axis cuts on the count scale, the median standing in when Otsu is refused", () => {
    const { summary } = judge(graph());
    for (const axis of [summary.afferent, summary.efferent]) {
      expect(["otsu", "median"]).toContain(axis.thresholdMethod);
      if (axis.thresholdMethod === "median") expect(axis.threshold).toBe(axis.median);
      else expect(axis.separability).toBeGreaterThanOrEqual(0.8);
    }
    expect(summary.efferent.median).toBe(5);
    expect(summary.violationCount).toBe(1);
  });

  it("falls back to the median floor alone when too few components are judged for Otsu", () => {
    // Four judged components: a hub over three plain ones.
    const g: FileDependencyGraph = {
      files: [
        ...["a1", "a2", "a3", "a4", "a5", "a6"].map((n) => file(`a/${n}.ts`)),
        ...["h1", "h2", "h3", "h4", "h5", "h6"].map((n) => file(`h/${n}.ts`)),
        ...["s1", "s2", "s3", "s4", "s5", "s6"].map((n) => file(`s/${n}.ts`)),
        file("z/z.ts"),
      ],
      edges: [
        ...[1, 2, 3, 4, 5, 6].map((i) => edge(`a/a${i}.ts`, `h/h${i}.ts`)),
        ...[1, 2, 3, 4, 5, 6].map((i) => edge(`h/h${i}.ts`, `s/s${i}.ts`)),
        ...[1, 2, 3, 4, 5].map((i) => edge(`s/s${i}.ts`, "z/z.ts")),
      ],
    };
    const report = judge(g);
    expect(report.summary.judgedComponentCount).toBe(4);
    expect(report.summary.afferent.thresholdMethod).toBe("median");
    expect(report.summary.afferent.separability).toBeUndefined();
    // INVARIANT CHANGED (bd tea-rags-mcp-g77p3): the Ce median is drawn over
    // the non-leaf a, h, s (6, 6, 5 → 6), not with leaf z (→ 5.5) — h's Ce 6
    // no longer clears it.
    expect(report.summary.efferent).toMatchObject({ thresholdMethod: "median", median: 6 });
    expect(report.violations).toEqual([]);
  });

  it("judges nothing and reports nothing when every component is below the floor", () => {
    const report = judge({ files: [file("a/a.ts"), file("b/b.ts")], edges: [edge("a/a.ts", "b/b.ts")] });
    expect(report.violations).toEqual([]);
    expect(report.summary.judgedComponentCount).toBe(0);
    expect(report.summary.excluded.lowConnectionCount).toBe(2);
    expect(report.summary.afferent).toEqual({ threshold: 0, thresholdMethod: "median", median: 0 });
  });

  it("attaches the hub's churn — mean commit count over its measured files — when volatility is given", () => {
    const fileVolatility = new Map([
      ["hub/h1.ts", 4],
      ["hub/h2.ts", 8],
      ["src1/f1.ts", 100],
    ]);
    const [hub] = judge(graph(), { fileVolatility }).violations;
    expect(hub.churn).toEqual({ value: 6, measuredFileCount: 2 });
  });

  it("reports only hubs holding a file matching sourcePathPattern; the cuts stay whole-graph", () => {
    // 19 judged components, src1 alone holds a matching file.
    const whole = judge(graph());
    const scoped = judge(graph(), { sourcePathPattern: "src1/**" });
    expect(scoped.violations).toEqual([]);
    expect(scoped.summary.scope).toEqual({ sourcePathPattern: "src1/**", outOfScopeComponentCount: 18 });
    expect(scoped.summary.afferent).toEqual(whole.summary.afferent);
    expect(judge(graph(), { sourcePathPattern: "hub/**" }).violations.map((v) => v.component)).toEqual(["hub"]);
  });

  // bd tea-rags-mcp-r8hme.52.4: the composition root is MEASURED — a component
  // holding an entry facade — never a declared path list (retired by the user).
  it("marks a hub that holds an entry facade as a composition root, without suppressing it", () => {
    const components = buildComponentGraph(graph(), []);
    const hubComponent = components.components.get("hub");
    if (!hubComponent) throw new Error("fixture: hub component missing");
    components.components.set("hub", { ...hubComponent, entryFacade: true });

    const [hub] = detectHubLikeDependencies(components).violations;
    expect(hub).toMatchObject({ component: "hub", compositionRoot: true });
  });

  it("names no hub a composition root by path: the retired declared root's dir carries no annotation", () => {
    const g = graph();
    const renamed: FileDependencyGraph = {
      files: g.files.map((f) => ({ ...f, relPath: f.relPath.replace(/^hub\//, "src/core/api/") })),
      edges: g.edges.map((e) => ({
        ...e,
        sourceRelPath: e.sourceRelPath.replace(/^hub\//, "src/core/api/"),
        targetRelPath: e.targetRelPath.replace(/^hub\//, "src/core/api/"),
      })),
    };
    const [hub] = judge(renamed).violations;
    expect(hub.component).toBe("src/core/api");
    expect("compositionRoot" in hub).toBe(false);
  });
});
