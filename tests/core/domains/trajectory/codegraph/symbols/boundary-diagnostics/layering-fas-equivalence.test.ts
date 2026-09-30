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
} from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/boundary-diagnostics/index.js";

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
