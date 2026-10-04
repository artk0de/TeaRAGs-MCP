/**
 * Keep cost per cut edge (bd tea-rags-mcp-r8hme.40): for one feedback-arc-set
 * edge e of a knot, cut every OTHER edge of the set and keep e — how many
 * members fall back into a cycle, and how many levels the members span with
 * those cycles condensed. Under the canonical Eades–Lin–Smyth order
 * (bd tea-rags-mcp-r8hme.42) the greedy takes one edge per 2-cycle and no
 * longer manufactures redundant cuts on these shapes — the "0 re-collapsed
 * members" reading names an edge whose every cycle another cut already broke.
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
    // Canonical ELS (bd tea-rags-mcp-r8hme.42): the weighted delta (+2) takes
    // a into the right block first, b follows as the sink, and the sequence
    // [b, a] reads a->b backwards — the heavy edge is the one cut.
    const { cut, costOf } = keepCostsOf(
      graphOf(
        ["a", "b"],
        [
          ["a", "b", 3],
          ["b", "a", 1],
        ],
      ),
    );

    expect(cut).toEqual(["a->b"]);
    expect(costOf("a->b")).toEqual({ recollapsedMemberCount: 2, levelsAfterKeep: 1 });
  });

  it("cuts one edge of a 3-cycle and prices keeping it as a full re-collapse", () => {
    // Canonical sequence [b, c, a]: the delta tie takes a into the right
    // block, b peels as a source, c as the sink — a->b is the only backward
    // edge, and one cut dissolves the cycle. Keeping it re-collapses all
    // three members onto one level. (The inverted pre-r8hme.42 order cut two
    // edges here and priced each as taking nothing needlessly.)
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

    expect(cut).toEqual(["a->b"]);
    expect(costOf("a->b")).toEqual({ recollapsedMemberCount: 3, levelsAfterKeep: 1 });
  });

  it("prices each cut of a four-pair ring by its own re-collapsed pair and the chain above it", () => {
    // Four adjacent pairs a⇄b, b⇄c, c⇄d, d⇄a — the weight-9 ring one way,
    // weight-1 back. Canonical sequence [d, c, b, a]: every ring direction
    // reads backwards, so the cut takes a->b, b->c, c->d and the wrap a->d —
    // one edge per pair. Keeping a ring edge re-collapses exactly its own
    // pair (2 members) and leaves the rest a chain on three levels; keeping
    // the wrap a->d revives every pair: all 4 members on one level.
    const { cut, costOf } = keepCostsOf(
      graphOf(
        ["a", "b", "c", "d"],
        [
          ["a", "b", 9],
          ["b", "a", 1],
          ["b", "c", 9],
          ["c", "b", 1],
          ["c", "d", 9],
          ["d", "c", 1],
          ["d", "a", 9],
          ["a", "d", 1],
        ],
      ),
    );

    expect(cut).toEqual(["a->b", "b->c", "c->d", "a->d"]);
    expect(costOf("a->b")).toEqual({ recollapsedMemberCount: 2, levelsAfterKeep: 3 });
    expect(costOf("b->c")).toEqual({ recollapsedMemberCount: 2, levelsAfterKeep: 3 });
    expect(costOf("c->d")).toEqual({ recollapsedMemberCount: 2, levelsAfterKeep: 3 });
    expect(costOf("a->d")).toEqual({ recollapsedMemberCount: 4, levelsAfterKeep: 1 });
  });
});
