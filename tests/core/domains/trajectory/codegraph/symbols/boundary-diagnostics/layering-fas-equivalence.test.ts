/**
 * The weighted Eades–Lin–Smyth feedback arc set inside every layering knot is
 * pinned against the pre-optimisation algorithm, kept here verbatim as a test
 * oracle: the incremental-degree rewrite must yield the identical cut —
 * same edges, same order, same tie-breaks — on every input. The scale case
 * guards the complexity: a 400-component knot used to cost O(V²·E) and never
 * finished on a large project's `get_architecture_report`.
 */
import { describe, expect, it } from "vitest";

import type {
  FileDependencyEdge,
  FileDependencyGraph,
} from "../../../../../../../src/core/contracts/types/codegraph.js";
import {
  buildComponentGraph,
  buildLayeringModel,
  type ComponentDependency,
  type LayeringKnot,
} from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/boundary-diagnostics/index.js";
import { tarjanScc } from "../../../../../../../src/core/infra/graph/tarjan-scc.js";

interface OracleFeedbackEdge {
  sourceComponent: string;
  targetComponent: string;
  callWeight: number;
}

function compareCodePoints(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Test oracle: the pre-optimisation `eadesLinSmyth` body, copied verbatim
 * (minus evidence file edges, which the comparison does not read). O(V²·E) —
 * only ever run on the small random graphs below.
 */
function referenceEadesLinSmyth(internal: readonly ComponentDependency[]): OracleFeedbackEdge[] {
  const position = new Map<string, number>();
  const remaining = new Set(internal.flatMap((d) => [d.sourceComponent, d.targetComponent]));
  const sequence: string[] = [];
  const liveOut = (node: string) =>
    internal.some((d) => d.sourceComponent === node && remaining.has(d.targetComponent));
  const liveIn = (node: string) => internal.some((d) => d.targetComponent === node && remaining.has(d.sourceComponent));
  const weightDelta = (node: string) => {
    let outWeight = 0;
    let inWeight = 0;
    for (const d of internal) {
      if (!remaining.has(d.sourceComponent) || !remaining.has(d.targetComponent)) continue;
      if (d.sourceComponent === node) outWeight += d.callWeight;
      if (d.targetComponent === node) inWeight += d.callWeight;
    }
    return outWeight - inWeight;
  };

  while (remaining.size > 0) {
    let moved = true;
    while (moved && remaining.size > 0) {
      moved = false;
      for (const node of [...remaining].sort(compareCodePoints)) {
        if (liveOut(node) && liveIn(node)) continue;
        if (!liveOut(node)) sequence.push(node);
        else sequence.unshift(node);
        remaining.delete(node);
        moved = true;
      }
    }
    if (remaining.size === 0) break;
    let best: string | undefined;
    let bestDelta = Number.NEGATIVE_INFINITY;
    for (const node of [...remaining].sort(compareCodePoints)) {
      const delta = weightDelta(node);
      if (delta > bestDelta) {
        bestDelta = delta;
        best = node;
      }
    }
    if (best === undefined) break;
    remaining.delete(best);
    sequence.push(best);
  }
  sequence.forEach((node, index) => position.set(node, index));

  return internal
    .filter((d) => (position.get(d.sourceComponent) ?? 0) > (position.get(d.targetComponent) ?? 0))
    .map((d) => ({ sourceComponent: d.sourceComponent, targetComponent: d.targetComponent, callWeight: d.callWeight }))
    .sort(
      (a, b) =>
        b.callWeight - a.callWeight ||
        compareCodePoints(a.sourceComponent, b.sourceComponent) ||
        compareCodePoints(a.targetComponent, b.targetComponent),
    );
}

/** Seeded PRNG (mulberry32) — reproducible graphs without a dependency. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function componentName(index: number): string {
  return `c${String(index).padStart(3, "0")}`;
}

/** One file per component (`cNNN/f.ts`); component edges become file edges. */
function graphOf(componentCount: number, pairs: readonly [number, number, number][]): FileDependencyGraph {
  const files = Array.from({ length: componentCount }, (_, i) => ({
    relPath: `${componentName(i)}/f.ts`,
    language: "typescript",
    symbolCount: 1,
  }));
  const edges: FileDependencyEdge[] = pairs.map(([s, t, w]) => ({
    sourceRelPath: `${componentName(s)}/f.ts`,
    targetRelPath: `${componentName(t)}/f.ts`,
    callWeight: w,
  }));
  return { files, edges };
}

function randomGraph(random: () => number): FileDependencyGraph {
  const componentCount = 3 + Math.floor(random() * 23);
  const density = 0.05 + random() * 0.35;
  const pairs: [number, number, number][] = [];
  for (let s = 0; s < componentCount; s++) {
    for (let t = 0; t < componentCount; t++) {
      if (s === t || random() >= density) continue;
      pairs.push([s, t, 1 + Math.floor(random() * 5)]);
    }
  }
  return graphOf(componentCount, pairs);
}

describe("layering knot feedback arc set", () => {
  it("matches the pre-optimisation Eades–Lin–Smyth on 200 seeded random graphs", () => {
    const random = mulberry32(0x5eed);
    let knotsCompared = 0;
    for (let round = 0; round < 200; round++) {
      const componentGraph = buildComponentGraph(randomGraph(random), []);
      const model = buildLayeringModel(componentGraph);
      for (const knot of model.knots) {
        const members = new Set(knot.components);
        const internal = componentGraph.dependencies.filter(
          (d) => members.has(d.sourceComponent) && members.has(d.targetComponent),
        );
        const actual = knot.feedbackArcSet.map(({ sourceComponent, targetComponent, callWeight }) => ({
          sourceComponent,
          targetComponent,
          callWeight,
        }));
        expect(actual, `round ${round}`).toEqual(referenceEadesLinSmyth(internal));
        knotsCompared++;
      }
    }
    expect(knotsCompared).toBeGreaterThan(100);
  });

  it("cuts a 400-component, ~4000-edge knot well inside the time budget", () => {
    const random = mulberry32(0xbadc0de);
    const componentCount = 400;
    const seen = new Set<string>();
    const pairs: [number, number, number][] = [];
    const add = (s: number, t: number) => {
      const key = `${s}->${t}`;
      if (s === t || seen.has(key)) return;
      seen.add(key);
      pairs.push([s, t, 1 + Math.floor(random() * 5)]);
    };
    // A Hamiltonian ring makes the whole graph one strongly connected knot.
    for (let i = 0; i < componentCount; i++) add(i, (i + 1) % componentCount);
    while (pairs.length < 4000) {
      add(Math.floor(random() * componentCount), Math.floor(random() * componentCount));
    }

    const model = buildLayeringModel(buildComponentGraph(graphOf(componentCount, pairs), []));

    expect(model.knots).toHaveLength(1);
    expect(model.knots[0]?.components).toHaveLength(componentCount);
    expect(model.knots[0]?.cutEdgeCount).toBeGreaterThan(0);
  }, 5_000);
});

/**
 * Test oracle for `levelsAfterCut` (bd tea-rags-mcp-r8hme.36): the
 * pre-optimisation whole-graph recompute, copied verbatim — Tarjan over the
 * FULL component graph with one knot's feedback arc set removed, the
 * condensation, and the longest path over it. O(E) per knot, so O(K·E) per
 * model; the member-local recompute must answer the same level count.
 */
function oracleAdjacency(dependencies: readonly ComponentDependency[]): Map<string, readonly string[]> {
  const out = new Map<string, string[]>();
  for (const dependency of dependencies) {
    const targets = out.get(dependency.sourceComponent) ?? [];
    if (!targets.includes(dependency.targetComponent)) targets.push(dependency.targetComponent);
    out.set(dependency.sourceComponent, targets);
  }
  return out;
}

function oracleKnotNode(index: number): string {
  return `${String.fromCharCode(0)}knot${index}`;
}

function oracleCondense(
  dependencies: readonly ComponentDependency[],
  knotOf: Map<string, number>,
): { outgoing: Map<string, string[]>; incoming: Map<string, string[]> } {
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  const nodeOf = (component: string) => {
    const knot = knotOf.get(component);
    return knot === undefined ? component : oracleKnotNode(knot);
  };
  const link = (map: Map<string, string[]>, from: string, to: string) => {
    if (from === to) return;
    const targets = map.get(from) ?? [];
    if (!targets.includes(to)) targets.push(to);
    map.set(from, targets);
  };
  for (const dependency of dependencies) {
    link(outgoing, nodeOf(dependency.sourceComponent), nodeOf(dependency.targetComponent));
    link(incoming, nodeOf(dependency.targetComponent), nodeOf(dependency.sourceComponent));
  }
  return { outgoing, incoming };
}

function oracleNodesOf(
  condensation: { outgoing: Map<string, string[]>; incoming: Map<string, string[]> },
  knotOf: Map<string, number>,
): string[] {
  return [
    ...new Set([
      ...condensation.outgoing.keys(),
      ...condensation.incoming.keys(),
      ...[...knotOf.keys()].map((_, index) => oracleKnotNode(index)),
    ]),
  ];
}

function oracleLongestPath(nodes: readonly string[], next: Map<string, string[]>): Map<string, number> {
  const memo = new Map<string, number>();
  const resolve = (node: string): number => {
    const cached = memo.get(node);
    if (cached !== undefined) return cached;
    memo.set(node, 0);
    const successors = next.get(node) ?? [];
    const value = successors.length === 0 ? 0 : 1 + Math.max(...successors.map(resolve));
    memo.set(node, value);
    return value;
  };
  nodes.forEach(resolve);
  return memo;
}

function oracleLevelsAfterCutOf(dependencies: readonly ComponentDependency[]): (component: string) => number {
  const postSccs = tarjanScc(oracleAdjacency(dependencies));
  const postKnotOf = new Map<string, number>();
  postSccs.forEach((members, index) => {
    members.forEach((member) => postKnotOf.set(member, index));
  });
  const postCondensation = oracleCondense(dependencies, postKnotOf);
  const postLevel = oracleLongestPath(oracleNodesOf(postCondensation, postKnotOf), postCondensation.outgoing);
  return (component: string) => {
    const knot = postKnotOf.get(component);
    return postLevel.get(knot === undefined ? component : oracleKnotNode(knot)) ?? 0;
  };
}

function oracleLevelsAfterCut(dependencies: readonly ComponentDependency[], knot: LayeringKnot): number {
  const key = (source: string, target: string) => `${source}->${target}`;
  const cut = new Set(knot.feedbackArcSet.map((edge) => key(edge.sourceComponent, edge.targetComponent)));
  const withoutCut = dependencies.filter((d) => !cut.has(key(d.sourceComponent, d.targetComponent)));
  const dissolvedLevel = oracleLevelsAfterCutOf(withoutCut);
  return new Set(knot.components.map(dissolvedLevel)).size;
}

/**
 * Groups stacked by rank, bottom first: a group of one is a plain DAG
 * component, a larger group a knot (a ring plus random chords). Edges between
 * groups only ever point from a higher rank to a lower one, so groups never
 * fuse into one SCC — and a knot member's edges down to a lower group are the
 * external-successor path the member-local recompute prices by base level.
 */
function stackedGroupGraph(
  groups: readonly (readonly number[])[],
  componentCount: number,
  random: () => number,
  crossEdgeCount: number,
  chordCount: (size: number) => number,
): FileDependencyGraph {
  const pairs: [number, number, number][] = [];
  const seen = new Set<string>();
  const weight = () => 1 + Math.floor(random() * 5);
  const add = (s: number, t: number) => {
    const key = `${s}->${t}`;
    if (s === t || seen.has(key)) return false;
    seen.add(key);
    pairs.push([s, t, weight()]);
    return true;
  };
  const pick = (group: readonly number[]) => group[Math.floor(random() * group.length)] ?? 0;
  for (const group of groups) {
    if (group.length < 2) continue;
    group.forEach((member, i) => add(member, group[(i + 1) % group.length] ?? member));
    for (let c = 0; c < chordCount(group.length); c++) add(pick(group), pick(group));
  }
  const target = pairs.length + crossEdgeCount;
  let attempts = 0;
  while (pairs.length < target && attempts < crossEdgeCount * 20) {
    attempts++;
    const a = Math.floor(random() * groups.length);
    const b = Math.floor(random() * groups.length);
    if (a === b) continue;
    const [lo, hi] = a < b ? [a, b] : [b, a];
    add(pick(groups[hi] ?? []), pick(groups[lo] ?? []));
  }
  return graphOf(componentCount, pairs);
}

function shuffled<T>(items: T[], random: () => number): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

function randomStackedKnotGraph(random: () => number): FileDependencyGraph {
  const groups: number[][] = [];
  let next = 0;
  const knotCount = 1 + Math.floor(random() * 4);
  for (let k = 0; k < knotCount; k++) {
    groups.push(Array.from({ length: 2 + Math.floor(random() * 7) }, () => next++));
  }
  const dagCount = 2 + Math.floor(random() * 12);
  for (let d = 0; d < dagCount; d++) groups.push([next++]);
  // Knots land above, between and below the DAG components.
  shuffled(groups, random);
  return stackedGroupGraph(groups, next, random, Math.floor(next * (1 + random() * 3)), (size) =>
    Math.floor(size * random() * 2),
  );
}

/**
 * Scale case: 200 knots of 20 chained through a 6000-component DAG, ~67k
 * edges. The whole-graph recompute per knot (O(K·E)) took 6.8 s on it; the
 * member-local recompute ~0.1 s.
 */
const SCALE_KNOT_COUNT = 200;
const SCALE_KNOT_SIZE = 20;
const SCALE_DAG_SIZE = 6000;
const SCALE_CROSS_EDGE_COUNT = 60_000;
const SCALE_BUDGET_MS = 1_500;

describe("layering knot levelsAfterCut", () => {
  it("matches the whole-graph recompute on 200 seeded graphs of stacked knots and DAG parts", () => {
    const random = mulberry32(0x1e7e15);
    let knotsCompared = 0;
    for (let round = 0; round < 200; round++) {
      const componentGraph = buildComponentGraph(randomStackedKnotGraph(random), []);
      const model = buildLayeringModel(componentGraph);
      for (const knot of model.knots) {
        expect(knot.levelsAfterCut, `round ${round}`).toBe(oracleLevelsAfterCut(componentGraph.dependencies, knot));
        knotsCompared++;
      }
    }
    expect(knotsCompared).toBeGreaterThan(300);
  });

  it("matches the whole-graph recompute on the 200 dense random graphs", () => {
    const random = mulberry32(0x5eed);
    for (let round = 0; round < 200; round++) {
      const componentGraph = buildComponentGraph(randomGraph(random), []);
      const model = buildLayeringModel(componentGraph);
      for (const knot of model.knots) {
        expect(knot.levelsAfterCut, `round ${round}`).toBe(oracleLevelsAfterCut(componentGraph.dependencies, knot));
      }
    }
  });

  it("levels 200 knots chained through a DAG of ~67k edges without a whole-graph recompute per knot", () => {
    const random = mulberry32(0xc4a1);
    const groups: number[][] = [];
    let next = 0;
    for (let d = 0; d < SCALE_DAG_SIZE; d++) groups.push([next++]);
    // Knot k sits at an even stride through the DAG ranks, so knots are
    // chained through the DAG and each has DAG parts above and below it.
    const stride = Math.floor(SCALE_DAG_SIZE / SCALE_KNOT_COUNT);
    for (let k = SCALE_KNOT_COUNT - 1; k >= 0; k--) {
      groups.splice(
        k * stride + 1,
        0,
        Array.from({ length: SCALE_KNOT_SIZE }, () => next++),
      );
    }
    const componentGraph = buildComponentGraph(
      stackedGroupGraph(groups, next, random, SCALE_CROSS_EDGE_COUNT, (size) => size),
      [],
    );

    const started = performance.now();
    const model = buildLayeringModel(componentGraph);
    const elapsed = performance.now() - started;

    expect(model.knots.filter((knot) => knot.components.length === SCALE_KNOT_SIZE)).toHaveLength(SCALE_KNOT_COUNT);
    expect(elapsed).toBeLessThan(SCALE_BUDGET_MS);
  }, 120_000);
});
