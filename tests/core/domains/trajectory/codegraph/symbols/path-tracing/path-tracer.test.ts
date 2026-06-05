// tests/core/domains/trajectory/codegraph/symbols/path-tracing/path-tracer.test.ts
import { describe, expect, it } from "vitest";

import { enumeratePaths } from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/path-tracing/path-tracer.js";

const adj = (entries: Record<string, string[]>): Map<string, string[]> => new Map(Object.entries(entries));

describe("enumeratePaths", () => {
  it("returns the single linear path A->B->C", () => {
    const r = enumeratePaths(adj({ A: ["B"], B: ["C"], C: [] }), "A", "C", { maxDepth: 8, maxPaths: 10 });
    expect(r.paths).toEqual([["A", "B", "C"]]);
    expect(r.truncated).toBe(false);
  });

  it("returns all simple paths when the graph branches", () => {
    const r = enumeratePaths(adj({ A: ["B", "D"], B: ["C"], D: ["C"], C: [] }), "A", "C", { maxDepth: 8, maxPaths: 10 });
    expect(r.paths).toContainEqual(["A", "B", "C"]);
    expect(r.paths).toContainEqual(["A", "D", "C"]);
    expect(r.paths).toHaveLength(2);
  });

  it("never loops on a cycle and still finds the exit path", () => {
    const r = enumeratePaths(adj({ A: ["B"], B: ["A", "C"], C: [] }), "A", "C", { maxDepth: 8, maxPaths: 10 });
    expect(r.paths).toEqual([["A", "B", "C"]]);
  });

  it("drops paths longer than maxDepth (depth = edge count)", () => {
    const r = enumeratePaths(adj({ A: ["B"], B: ["C"], C: ["D"], D: [] }), "A", "D", { maxDepth: 2, maxPaths: 10 });
    expect(r.paths).toEqual([]); // A->B->C->D is 3 edges > maxDepth 2
  });

  it("caps the result at maxPaths and flags truncation", () => {
    const r = enumeratePaths(adj({ A: ["B", "C", "D"], B: ["E"], C: ["E"], D: ["E"], E: [] }), "A", "E", {
      maxDepth: 8,
      maxPaths: 2,
    });
    expect(r.paths).toHaveLength(2);
    expect(r.truncated).toBe(true);
  });

  it("returns empty when no path exists", () => {
    const r = enumeratePaths(adj({ A: ["B"], B: [], C: [] }), "A", "C", { maxDepth: 8, maxPaths: 10 });
    expect(r.paths).toEqual([]);
    expect(r.truncated).toBe(false);
  });

  it("returns the trivial one-node path when from === to", () => {
    const r = enumeratePaths(adj({ A: ["B"] }), "A", "A", { maxDepth: 8, maxPaths: 10 });
    expect(r.paths).toEqual([["A"]]);
  });

  it("returns empty when the start node is absent from the adjacency", () => {
    const r = enumeratePaths(adj({ B: ["C"] }), "A", "C", { maxDepth: 8, maxPaths: 10 });
    expect(r.paths).toEqual([]);
  });
});
