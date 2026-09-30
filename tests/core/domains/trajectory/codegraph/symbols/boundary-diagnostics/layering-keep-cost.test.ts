/**
 * Keep cost per cut edge (bd tea-rags-mcp-r8hme.40): for one feedback-arc-set
 * edge e of a knot, cut every OTHER edge of the set and keep e — how many
 * members fall back into a cycle, and how many levels the members span with
 * those cycles condensed. 0 re-collapsed members names an edge the greedy
 * cut took needlessly.
 */
import { describe, expect, it } from "vitest";

import type { FileDependencyGraph } from "../../../../../../../src/core/contracts/types/codegraph.js";
import {
  buildComponentGraph,
  buildLayeringModel,
  layeringKnotKeepCosts,
} from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/boundary-diagnostics/index.js";

/** One file per component `<name>/f.ts`; `edges` are `[source, target, callWeight]`. */
function graphOf(names: readonly string[], edges: readonly [string, string, number][]): FileDependencyGraph {
  return {
    files: names.map((name) => ({ relPath: `${name}/f.ts`, language: "typescript", symbolCount: 1 })),
    edges: edges.map(([source, target, callWeight]) => ({
      sourceRelPath: `${source}/f.ts`,
      targetRelPath: `${target}/f.ts`,
      callWeight,
    })),
  };
}

/** The single knot of `graph`, its cut as `source->target` pairs, and the keep cost of every cut edge. */
function keepCostsOf(graph: FileDependencyGraph) {
  const componentGraph = buildComponentGraph(graph, []);
  const model = buildLayeringModel(componentGraph);
  expect(model.knots).toHaveLength(1);
  const [knot] = model.knots;
  if (!knot) throw new Error("no knot");
  const priced = layeringKnotKeepCosts(componentGraph, model, knot, knot.feedbackArcSet);
  const pairOf = (edge: { sourceComponent: string; targetComponent: string }) =>
    `${edge.sourceComponent}->${edge.targetComponent}`;
  return {
    cut: knot.feedbackArcSet.map(pairOf),
    costOf: (pair: string) => priced.find(({ edge }) => pairOf(edge) === pair)?.keepCost,
  };
}

describe("layeringKnotKeepCosts", () => {
  it("re-collapses both members of a 2-cycle when its one cut edge stays", () => {
    // Eades–Lin–Smyth takes a (weighted delta +2) first; b->a is the one backward edge.
    const { cut, costOf } = keepCostsOf(
      graphOf(
        ["a", "b"],
        [
          ["a", "b", 3],
          ["b", "a", 1],
        ],
      ),
    );

    expect(cut).toEqual(["b->a"]);
    expect(costOf("b->a")).toEqual({ recollapsedMemberCount: 2, levelsAfterKeep: 1 });
  });

  it("prices 0 re-collapsed members for an edge the greedy cut took needlessly", () => {
    // A 3-cycle a->b->c->a needs ONE cut edge. The greedy sequence is b, a, c
    // (a has the largest weighted delta, then b peels as a source and c as a
    // sink), which leaves a->b AND c->a backward: two edges, and either one
    // alone keeps the rest acyclic.
    const { cut, costOf } = keepCostsOf(
      graphOf(
        ["a", "b", "c"],
        [
          ["a", "b", 4],
          ["b", "c", 2],
          ["c", "a", 3],
        ],
      ),
    );

    expect(cut).toEqual(["a->b", "c->a"]);
    // Keep a->b: b->c, a->b remain — c, b, a on three levels.
    expect(costOf("a->b")).toEqual({ recollapsedMemberCount: 0, levelsAfterKeep: 3 });
    // Keep c->a: b->c, c->a remain — a, c, b on three levels.
    expect(costOf("c->a")).toEqual({ recollapsedMemberCount: 0, levelsAfterKeep: 3 });
  });

  it("condenses the re-collapsed members and levels them over the external successors' base levels", () => {
    // Knot {a, b, c}; c depends on z, z on y outside it (base levels 1 and 0).
    // Greedy sequence b, a, c: the cut is a->b and c->a.
    const { cut, costOf } = keepCostsOf(
      graphOf(
        ["a", "b", "c", "y", "z"],
        [
          ["a", "b", 5],
          ["b", "a", 1],
          ["b", "c", 5],
          ["c", "a", 1],
          ["c", "z", 1],
          ["z", "y", 1],
        ],
      ),
    );

    expect(cut).toEqual(["a->b", "c->a"]);
    // Keep a->b: a⇄b re-collapse; c sits at 1 + level(z) = 2, {a, b} above it — two levels.
    expect(costOf("a->b")).toEqual({ recollapsedMemberCount: 2, levelsAfterKeep: 2 });
    // Keep c->a: acyclic — a at 0, c at max(1 + 0, 1 + 1) = 2, b at 3.
    expect(costOf("c->a")).toEqual({ recollapsedMemberCount: 0, levelsAfterKeep: 3 });
  });
});
