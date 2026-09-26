/**
 * Closure-batch packing for the TypeScript resolver's Programs (bd
 * tea-rags-mcp-vtuu4).
 *
 * A whole-project Program on taxdome held 117.6 MB of source text and ~5.4 GB
 * of heap; the spike measured that heap scales with TEXT (AST + bind ≈ 30 MB
 * per MB) and checker work with CALL SITES (≈ 30 KB each). So batches are
 * bounded on exactly those two axes, and every root is resolved in a Program
 * that holds its full forward closure. These cases pin the packing rules on
 * graph literals; the I/O that builds a real graph is tested beside it.
 */

import { describe, expect, it } from "vitest";

import {
  TSProgramBatchPlanner,
  type TSProgramBatchPlan,
} from "../../../../../../src/core/domains/language/typescript/resolver/ts-program-batch-planner.js";
import type { TSProgramImportGraph } from "../../../../../../src/core/domains/language/typescript/resolver/ts-program-import-graph.js";

interface NodeSpec {
  readonly text: number;
  readonly imports?: readonly string[];
}

/** A graph from `{ name: { text, imports } }`, node order = key order. */
function graphOf(spec: Record<string, NodeSpec>, preludeSeeds: readonly string[] = []): TSProgramImportGraph {
  const names = Object.keys(spec);
  const index = new Map(names.map((name, i) => [name, i]));
  return {
    nodes: names.map((name) => ({
      fileName: `/repo/${name}`,
      textBytes: spec[name].text,
      imports: (spec[name].imports ?? []).map((target) => {
        const at = index.get(target);
        if (at === undefined) throw new Error(`unknown node ${target}`);
        return at;
      }),
    })),
    preludeSeeds: preludeSeeds.map((name) => index.get(name) ?? -1),
  };
}

function rootsOf(
  graph: TSProgramImportGraph,
  calls: Record<string, number>,
): { fileName: string; callSites: number }[] {
  return Object.entries(calls).map(([name, callSites]) => ({ fileName: `/repo/${name}`, callSites }));
}

const strip = (fileName: string): string => fileName.replace("/repo/", "");

function resolvedPerBatch(plan: TSProgramBatchPlan): string[][] {
  return plan.batches.map((batch) => batch.resolves.map(strip).sort());
}

describe("TSProgramBatchPlanner (bd tea-rags-mcp-vtuu4)", () => {
  it("keeps every batch under the text budget and the call cap", () => {
    const graph = graphOf({
      a: { text: 40 },
      b: { text: 40 },
      c: { text: 40 },
      d: { text: 40 },
      e: { text: 40 },
    });
    const planner = new TSProgramBatchPlanner({ textBudgetBytes: 100, callSiteCap: 25 });

    const plan = planner.plan(graph, rootsOf(graph, { a: 10, b: 10, c: 10, d: 10, e: 10 }));

    expect(plan.batches.length).toBeGreaterThan(1);
    for (const batch of plan.batches) {
      expect(batch.textBytes).toBeLessThanOrEqual(100);
      expect(batch.callSites).toBeLessThanOrEqual(25);
    }
  });

  it("packs roots in DFS postorder from the entry roots", () => {
    // a → b → c. Directory order would visit a first; postorder visits the
    // leaf first, so each batch opens where the previous one's parses are hot.
    const graph = graphOf({
      a: { text: 1, imports: ["b"] },
      b: { text: 1, imports: ["c"] },
      c: { text: 1 },
    });
    const planner = new TSProgramBatchPlanner({ textBudgetBytes: 1000, callSiteCap: 10 });

    const plan = planner.plan(graph, rootsOf(graph, { a: 10, b: 10, c: 10 }));

    expect(resolvedPerBatch(plan)).toEqual([["c"], ["b"], ["a"]]);
  });

  it("separates a root whose own closure exceeds the text budget as oversize", () => {
    const graph = graphOf({
      small: { text: 10 },
      hub: { text: 10, imports: ["heavy1", "heavy2"] },
      heavy1: { text: 60 },
      heavy2: { text: 60 },
    });
    const planner = new TSProgramBatchPlanner({ textBudgetBytes: 100, callSiteCap: 1000 });

    const plan = planner.plan(graph, rootsOf(graph, { small: 1, hub: 1 }));

    expect(plan.oversize.map((unit) => strip(unit.rootName))).toEqual(["hub"]);
    expect(plan.oversize[0]).toMatchObject({ textBytes: 130, callSites: 1 });
    expect(resolvedPerBatch(plan)).toEqual([["small"]]);
  });

  it("carries the prelude on every batch and charges its text to each", () => {
    const graph = graphOf(
      {
        globals: { text: 30, imports: ["globalDep"] },
        globalDep: { text: 10 },
        a: { text: 40 },
        b: { text: 40 },
      },
      ["globals"],
    );
    const planner = new TSProgramBatchPlanner({ textBudgetBytes: 90, callSiteCap: 1000 });

    const plan = planner.plan(graph, rootsOf(graph, { a: 1, b: 1 }));

    expect(plan.prelude.rootNames.map(strip)).toEqual(["globals"]);
    expect(plan.prelude.files.map(strip).sort()).toEqual(["globalDep", "globals"]);
    expect(plan.prelude.textBytes).toBe(40);
    // 40 of prelude + one 40-byte root fits 90; two roots do not.
    expect(plan.batches).toHaveLength(2);
    for (const batch of plan.batches) expect(batch.textBytes).toBe(80);
  });

  it("assigns every root to exactly one batch or to oversize", () => {
    const graph = graphOf({
      a: { text: 5, imports: ["shared"] },
      b: { text: 5, imports: ["shared"] },
      shared: { text: 5 },
      c: { text: 5 },
      big: { text: 500 },
    });
    const planner = new TSProgramBatchPlanner({ textBudgetBytes: 12, callSiteCap: 1000 });

    const plan = planner.plan(graph, rootsOf(graph, { a: 1, b: 1, shared: 1, c: 1, big: 1 }));

    const assigned = [...plan.batches.flatMap((batch) => batch.resolves), ...plan.oversize.map((u) => u.rootName)];
    expect(assigned.map(strip).sort()).toEqual(["a", "b", "big", "c", "shared"]);
    expect(new Set(assigned).size).toBe(assigned.length);
  });

  it("places a root that alone exceeds the call cap in a batch of its own", () => {
    const graph = graphOf({ busy: { text: 5 }, quiet: { text: 5 } });
    const planner = new TSProgramBatchPlanner({ textBudgetBytes: 1000, callSiteCap: 10 });

    const plan = planner.plan(graph, rootsOf(graph, { busy: 50, quiet: 1 }));

    expect(resolvedPerBatch(plan).sort()).toEqual([["busy"], ["quiet"]]);
    expect(plan.oversize).toEqual([]);
  });

  it("roots a batch's Program at the prelude plus the roots it chose", () => {
    const graph = graphOf(
      {
        globals: { text: 1 },
        a: { text: 1, imports: ["b"] },
        b: { text: 1 },
      },
      ["globals"],
    );
    const planner = new TSProgramBatchPlanner({ textBudgetBytes: 1000, callSiteCap: 1000 });

    const plan = planner.plan(graph, rootsOf(graph, { a: 1, b: 1 }));

    // One batch: b resolves there too, because a's closure already holds it.
    expect(resolvedPerBatch(plan)).toEqual([["a", "b"]]);
    expect(plan.batches[0].rootNames.map(strip)).toContain("a");
  });

  it("produces the same plan for the same graph", () => {
    const spec = {
      a: { text: 3, imports: ["c"] },
      b: { text: 3, imports: ["c", "d"] },
      c: { text: 3 },
      d: { text: 3 },
      e: { text: 3 },
    };
    const calls = { a: 2, b: 2, c: 2, d: 2, e: 2 };
    const planner = new TSProgramBatchPlanner({ textBudgetBytes: 9, callSiteCap: 4 });

    const first = planner.plan(graphOf(spec), rootsOf(graphOf(spec), calls));
    const second = planner.plan(graphOf(spec), rootsOf(graphOf(spec), calls));

    expect(second).toEqual(first);
  });
});
