/**
 * Canonical Eades–Lin–Smyth sequence order (bd tea-rags-mcp-r8hme.42): sources
 * append to the LEFT block in peel order — no reversal; sinks and max-delta
 * picks PREPEND to the RIGHT block, i.e. collected with push the right block
 * reads reversed. The inverted assembly (sources reversed, right block kept in
 * removal order) reported every edge of a pure source-chain DAG as feedback —
 * a DAG produced a full feedback arc set, measured as 99.7% needless cuts on
 * taxdome.
 */
import { describe, expect, it } from "vitest";

import type { FileDependencyGraph } from "../../../../../../../src/core/contracts/types/codegraph.js";
import {
  buildComponentGraph,
  buildLayeringModel,
} from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/boundary-diagnostics/index.js";
import { eadesLinSmyth } from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/boundary-diagnostics/layering.js";
import type { ComponentDependency } from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/boundary-diagnostics/types.js";

function dep(sourceComponent: string, targetComponent: string, callWeight = 1): ComponentDependency {
  return {
    sourceComponent,
    targetComponent,
    directoryRelation: "disjoint",
    callWeight,
    fileEdges: [{ sourceRelPath: `${sourceComponent}/f.ts`, targetRelPath: `${targetComponent}/f.ts`, callWeight }],
  };
}

function graphOf(edges: readonly [string, string, number?][]): FileDependencyGraph {
  const names = [...new Set(edges.flatMap(([source, target]) => [source, target]))];
  return {
    files: names.map((name) => ({ relPath: `${name}/f.ts`, language: "typescript", symbolCount: 1 })),
    edges: edges.map(([source, target, callWeight]) => ({
      sourceRelPath: `${source}/f.ts`,
      targetRelPath: `${target}/f.ts`,
      callWeight: callWeight ?? 1,
    })),
  };
}

describe("eadesLinSmyth — canonical sequence order (bd tea-rags-mcp-r8hme.42)", () => {
  it("cuts nothing from a pure source-chain DAG", () => {
    // u1→u2→u3: the peel pass takes u1 (source), then u2 (its in-edge died),
    // then u3 as the sink. The canonical sequence [u1, u2, u3] IS the
    // topological order, so the feedback arc set must be empty — an acyclic
    // graph can never need a cut. The inverted assembly read the front block
    // backwards, [u2, u1, u3], and reported u1→u2 as feedback.
    expect(eadesLinSmyth([dep("u1", "u2"), dep("u2", "u3")])).toEqual([]);
  });

  it("cuts exactly one edge of the minimal cycle, the one canonical ELS names", () => {
    // a⇄b at equal weight: neither vertex peels, the delta tie breaks to the
    // first in code-point order (a), which joins the right block first; b
    // becomes the sink and joins after it. Canonical sequence [b, a]: a→b
    // points from later to earlier and is the cut — b→a reads forward.
    const model = buildLayeringModel(
      buildComponentGraph(
        graphOf([
          ["a", "b", 2],
          ["b", "a", 2],
        ]),
        [],
      ),
    );

    expect(model.knots).toHaveLength(1);
    expect(model.knots[0]?.feedbackArcSet.map((edge) => [edge.sourceComponent, edge.targetComponent])).toEqual([
      ["a", "b"],
    ]);
  });

  it("keeps sources in peel order and reads the right block reversed — hand-derived cut", () => {
    // Graph: s1→s2, s2→b, b⇄c, c→d. Hand derivation of canonical ELS:
    //   Peel pass (code-point order b, c, d, s1, s2): d is the sink → right
    //   block; s1 is the source → left block; s2's in-edge died with s1, so it
    //   follows as a source. b and c still cover each other.
    //   Delta over {b, c}: b has out 1, in 1; c has out 1 (c→b — c→d died
    //   with d), in 1 — a tie, broken to b, which joins the right block
    //   first; c becomes the sink and joins after it.
    //   Removal order: left [s1, s2], right [d, b, c].
    //   Canonical sequence: [s1, s2] ++ [c, b, d] — positions s1 0, s2 1,
    //   c 2, b 3, d 4. Only b→c points from later to earlier: the cut.
    // The inverted assembly produced [s2, s1, d, b, c] and cut s1→s2 (front
    // reversal) and c→b (right block kept in removal order) — three edges
    // where one suffices, two of them on an acyclic path.
    const cut = eadesLinSmyth([dep("s1", "s2"), dep("s2", "b"), dep("b", "c"), dep("c", "b"), dep("c", "d")]);

    expect(cut.map((edge) => [edge.sourceComponent, edge.targetComponent])).toEqual([["b", "c"]]);
  });
});
