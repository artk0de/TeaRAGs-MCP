/**
 * The per-file edge cap is a POLICY over every `GraphEdges` kind (bd
 * tea-rags-mcp-89k7k.35.17). The cap used to sum `fileEdges` and `methodEdges`
 * by hand, so a new kind added to `GraphEdges` was silently left out of it —
 * neither counted nor consciously exempted. These tests pin the classification
 * of each existing kind, the count the cap reads, and the compile-time guard
 * that refuses an unclassified kind.
 */

import { describe, expect, expectTypeOf, it } from "vitest";

import type { GraphEdges } from "../../../../../../src/core/contracts/types/codegraph.js";
import {
  countCappedGraphEdges,
  GRAPH_EDGE_CAP_POLICY,
  MAX_EDGES_PER_FILE,
  pathologicalFileGraphEdges,
  type GraphEdgeCapPolicy,
  type GraphEdgeKind,
} from "../../../../../../src/core/domains/trajectory/codegraph/symbols/graph-edge-cap-policy.js";

function edgesOf(fileEdges: number, methodEdges: number, extra: Partial<GraphEdges> = {}): GraphEdges {
  return {
    fileEdges: Array.from({ length: fileEdges }, (_, i) => ({ targetRelPath: `f${i}.ts`, importText: null })),
    methodEdges: Array.from({ length: methodEdges }, (_, i) => ({
      sourceSymbolId: `S#m${i}`,
      targetSymbolId: null,
      targetRelPath: "t.ts",
      callExpression: `m${i}()`,
    })),
    ...extra,
  };
}

describe("GRAPH_EDGE_CAP_POLICY", () => {
  it("classifies every GraphEdges kind, and nothing else", () => {
    expectTypeOf<keyof typeof GRAPH_EDGE_CAP_POLICY>().toEqualTypeOf<keyof GraphEdges>();
    expect(Object.keys(GRAPH_EDGE_CAP_POLICY).sort()).toEqual(
      [
        "ambiguousFanouts",
        "fileEdges",
        "hierarchyDependencies",
        "inheritance",
        "methodEdges",
        "pass1Aggregates",
        "typeOnlyFileEdges",
      ].sort(),
    );
  });

  it("counts file and method edges and exempts every other kind", () => {
    expect(GRAPH_EDGE_CAP_POLICY.fileEdges).toBe("counted");
    expect(GRAPH_EDGE_CAP_POLICY.methodEdges).toBe("counted");
    // Mirrored into fileEdges since 89k7k.31 — counting it again would double.
    expect(GRAPH_EDGE_CAP_POLICY.typeOnlyFileEdges).toBe("exempt");
    expect(GRAPH_EDGE_CAP_POLICY.inheritance).toBe("exempt");
    expect(GRAPH_EDGE_CAP_POLICY.ambiguousFanouts).toBe("exempt");
    expect(GRAPH_EDGE_CAP_POLICY.pass1Aggregates).toBe("exempt");
    expect(GRAPH_EDGE_CAP_POLICY.hierarchyDependencies).toBe("exempt");
  });

  it("refuses, at compile time, an edge kind the policy does not classify", () => {
    // A future `GraphEdges` member stands in as an extra key of the kind union:
    // a policy missing it is not a policy for that union.
    // @ts-expect-error — `fieldAccessEdges` is unclassified, so the record is incomplete.
    const incomplete: GraphEdgeCapPolicy<GraphEdgeKind | "fieldAccessEdges"> = GRAPH_EDGE_CAP_POLICY;
    expect(incomplete).toBe(GRAPH_EDGE_CAP_POLICY);
  });
});

describe("countCappedGraphEdges", () => {
  it("sums the counted kinds only", () => {
    const edges = edgesOf(3, 4, {
      typeOnlyFileEdges: [{ targetRelPath: "x.ts", importText: null }],
      inheritance: [],
      ambiguousFanouts: [{ sourceSymbolId: "S#a", callExpression: "a()", member: "a", candidateCount: 9 }],
      hierarchyDependencies: [{ typeName: "T", descendantNames: ["U"] }],
    });
    expect(countCappedGraphEdges(edges)).toBe(7);
  });

  it("puts a file over the cap exactly when its counted edges exceed MAX_EDGES_PER_FILE", () => {
    expect(MAX_EDGES_PER_FILE).toBe(10000);
    expect(countCappedGraphEdges(edgesOf(MAX_EDGES_PER_FILE, 0))).toBe(MAX_EDGES_PER_FILE);
    expect(countCappedGraphEdges(edgesOf(MAX_EDGES_PER_FILE - 1, 2))).toBe(MAX_EDGES_PER_FILE + 1);
  });
});

describe("pathologicalFileGraphEdges", () => {
  it("lands the row with no edges of any kind", () => {
    expect(pathologicalFileGraphEdges()).toEqual({ fileEdges: [], methodEdges: [] });
  });

  it("returns a fresh value per call so a caller cannot alias another file's slice", () => {
    expect(pathologicalFileGraphEdges()).not.toBe(pathologicalFileGraphEdges());
  });
});
