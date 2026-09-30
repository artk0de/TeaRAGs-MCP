/**
 * `weightThresholdComponents` — the shared clustering primitive of the
 * behavioral-cohesion family (bd tea-rags-mcp-tzy8r + tea-rags-mcp-w7be6): A3
 * clusters a file's symbols over co-change history, D1 a class's methods over
 * structure. Both ask the same question — which parts hang together above a
 * weight threshold, and how far the whole is from one component.
 */

import { describe, expect, it } from "vitest";

import { weightThresholdComponents } from "../../../../src/core/infra/graph/index.js";

const e = (a: string, b: string, weight: number) => ({ a, b, weight });

describe("weightThresholdComponents", () => {
  it("keeps only edges at or above the threshold, then unions the rest", () => {
    const analysis = weightThresholdComponents([e("a", "b", 3), e("b", "c", 2), e("d", "e", 4), e("c", "d", 1)], {
      minWeight: 2,
    });

    // c—d (weight 1) sits below the threshold and bridges nothing.
    expect(analysis.components.map((c) => [...c.nodes].sort())).toEqual([
      ["a", "b", "c"],
      ["d", "e"],
    ]);
    expect(analysis.components.map((c) => c.internalWeight)).toEqual([5, 4]);
  });

  it("merges chains through shared members, not just direct pairs", () => {
    const analysis = weightThresholdComponents([e("a", "b", 2), e("b", "c", 2), e("c", "d", 2)], {
      minWeight: 2,
    });

    expect(analysis.components).toHaveLength(1);
    expect([...analysis.components[0].nodes].sort()).toEqual(["a", "b", "c", "d"]);
    expect(analysis.components[0].internalWeight).toBe(6);
  });

  it("reports the largest component's share of admitted weight", () => {
    const analysis = weightThresholdComponents([e("a", "b", 3), e("c", "d", 1)], { minWeight: 1 });

    expect(analysis.largestWeightShare).toBeCloseTo(3 / 4);
  });

  it("reads share 1 when nothing splits — one component or no edges at all", () => {
    expect(weightThresholdComponents([e("a", "b", 2)], { minWeight: 2 }).largestWeightShare).toBe(1);
    expect(weightThresholdComponents([], { minWeight: 2 }).largestWeightShare).toBe(1);
    expect(weightThresholdComponents([], { minWeight: 2 }).components).toEqual([]);
  });

  it("orders equal-weight components deterministically by their first member", () => {
    const analysis = weightThresholdComponents([e("z", "y", 2), e("b", "a", 2)], { minWeight: 2 });

    expect(analysis.components.map((c) => [...c.nodes].sort())).toEqual([
      ["a", "b"],
      ["y", "z"],
    ]);
  });
});
