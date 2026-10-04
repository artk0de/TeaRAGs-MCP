/**
 * Canonical Eades–Lin–Smyth sequence order inside weightedFeedbackArcSet (bd
 * tea-rags-mcp-89k7k.12): sources append to the LEFT block in peel order — no
 * reversal; sinks and max-delta picks append to the RIGHT block in removal
 * order, which reads reversed. The inverted assembly (sources unshifted onto a
 * single list, sinks and picks appended) reported edges of a pure source-chain
 * DAG as feedback — the same inversion class bd tea-rags-mcp-r8hme.42 fixed in
 * layering.ts, one file over. The consumer is buildLayerMap (layer-map.ts),
 * whose knot cut edges inherit whatever order this function names.
 */
import { describe, expect, it } from "vitest";

import {
  weightedFeedbackArcSet,
  type SimpleEdge,
} from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/boundary-diagnostics/layer-graph.js";

function edge(source: string, target: string, callWeight = 1): SimpleEdge {
  return { source, target, callWeight };
}

describe("weightedFeedbackArcSet — canonical sequence order (bd tea-rags-mcp-89k7k.12)", () => {
  it("cuts nothing from a pure source-chain DAG", () => {
    // u1→u2→u3: the peel pass takes u1 (source), then u2 (its in-edge died),
    // then u3 as the sink. The canonical sequence [u1, u2, u3] IS the
    // topological order, so the feedback arc set must be empty — an acyclic
    // graph can never need a cut. The inverted assembly unshifted each source
    // to the very front, [u2, u1, u3], and reported u1→u2 as feedback.
    expect(weightedFeedbackArcSet([edge("u1", "u2"), edge("u2", "u3")])).toEqual([]);
  });

  it("cuts exactly one edge of the minimal cycle, the one canonical ELS names", () => {
    // a⇄b at equal weight: neither vertex peels, the delta tie breaks to the
    // first in code-point order (a), which joins the right block first; b
    // becomes the sink and joins after it. Canonical sequence [b, a]: a→b
    // points from later to earlier and is the cut — b→a reads forward.
    expect(weightedFeedbackArcSet([edge("a", "b", 2), edge("b", "a", 2)])).toEqual([
      { source: "a", target: "b", callWeight: 2 },
    ]);
  });

  it("keeps sources in peel order and reads the right block reversed — hand-derived cut", () => {
    // Graph: a→b (1), b→c (3), c→b (1), c→d (1). Hand derivation of canonical
    // ELS:
    //   Peel pass (code-point order a, b, c, d): a is the source → left block;
    //   d is the sink → right block. b and c still cover each other.
    //   Delta over {b, c}, weights live: b has out 3, in 1 (+2); c has out 1,
    //   in 3 (−2) — b wins on weight, joins the right block first; c becomes
    //   the sink and joins after it.
    //   Removal order: left [a], right [d, b, c].
    //   Canonical sequence: [a] ++ [c, b, d] — positions a 0, c 1, b 2, d 3.
    //   Only b→c points from later to earlier: the cut, one edge on the cycle.
    // The inverted assembly produced [a, d, b, c] and cut c→b (right block
    // kept in removal order) and c→d (an acyclic-tail edge a DAG never owes) —
    // two cuts where one suffices.
    const cut = weightedFeedbackArcSet([edge("a", "b"), edge("b", "c", 3), edge("c", "b"), edge("c", "d")]);

    expect(cut.map((edge) => [edge.source, edge.target])).toEqual([["b", "c"]]);
  });
});
