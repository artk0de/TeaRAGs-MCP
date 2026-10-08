/**
 * Propagation cost (MacCormack, Rusnak & Baldwin's DSM measure; bd
 * tea-rags-mcp-r8hme.49): the density of the reflexive transitive closure of
 * the file dependency matrix — the mean share of the system one change can
 * reach — plus a per-component breakdown and the Baldwin–MacCormack
 * core-periphery classification by visibility fan-in / fan-out.
 */
import { describe, expect, it } from "vitest";

import type {
  FileDependencyEdge,
  FileDependencyGraph,
} from "../../../../../../../src/core/contracts/types/codegraph.js";
import { computePropagationCost } from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/boundary-diagnostics/index.js";

function file(relPath: string) {
  return { relPath, language: "typescript", symbolCount: 1 };
}

function edge(sourceRelPath: string, targetRelPath: string): FileDependencyEdge {
  return { sourceRelPath, targetRelPath, callWeight: 1 };
}

const range = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => `${prefix}/f${i}.ts`);

/**
 * `core/`    — a ring of 6 files (one SCC), depends on every `shared/` file.
 * `control/` — 10 files, each depending on the core ring.
 * `shared/`  — 10 leaf files.
 * `periph/`  — 10 files with no dependency at all.
 */
function corePeripheryGraph(): FileDependencyGraph {
  const core = range("core", 6);
  const control = range("control", 10);
  const shared = range("shared", 10);
  const periph = range("periph", 10);
  const edges = [
    ...core.map((f, i) => edge(f, core[(i + 1) % core.length])),
    ...control.map((f) => edge(f, core[0])),
    ...shared.map((f) => edge(core[3], f)),
  ];
  return { files: [...core, ...control, ...shared, ...periph].map(file), edges };
}

const componentOfDir = (graph: FileDependencyGraph) =>
  new Map(graph.files.map((f) => [f.relPath, `${f.relPath.split("/")[0]}/`]));

describe("computePropagationCost", () => {
  it("is the closure density of a chain: 6 reachable pairs over 3² cells", () => {
    const graph: FileDependencyGraph = {
      files: ["a.ts", "b.ts", "c.ts"].map(file),
      // The self-edge and the unwalked endpoint never count.
      edges: [edge("a.ts", "b.ts"), edge("b.ts", "c.ts"), edge("c.ts", "c.ts"), edge("c.ts", "vendor/x.ts")],
    };
    const report = computePropagationCost(graph);
    expect(report.fileCount).toBe(3);
    expect(report.edgeCount).toBe(2);
    expect(report.propagationCost).toBeCloseTo(6 / 9, 10);
    expect(report.largestCycleSize).toBe(1);
  });

  it("is 1 for a single cycle and 0 for an empty graph", () => {
    const ring: FileDependencyGraph = {
      files: ["a.ts", "b.ts", "c.ts"].map(file),
      edges: [edge("a.ts", "b.ts"), edge("b.ts", "c.ts"), edge("c.ts", "a.ts")],
    };
    expect(computePropagationCost(ring).propagationCost).toBe(1);
    expect(computePropagationCost(ring).largestCycleSize).toBe(3);
    const empty = computePropagationCost({ files: [], edges: [] });
    expect(empty.propagationCost).toBe(0);
    // No population to cut: both axes fall back to the floor, so the shape is
    // undecided rather than hierarchical.
    expect(empty.corePeriphery.visibilityFanIn.method).toBe("majority");
    expect(empty.corePeriphery.shape).toBe("indeterminate");
  });

  it("classifies core, shared, control and peripheral files by bimodal visibility cuts", () => {
    const graph = corePeripheryGraph();
    const report = computePropagationCost(graph);
    const { corePeriphery } = report;
    expect(corePeriphery.shape).toBe("corePeriphery");
    expect(corePeriphery.visibilityFanIn.method).toBe("otsu");
    expect(corePeriphery.visibilityFanOut.method).toBe("otsu");
    expect(corePeriphery.counts).toEqual({ core: 6, shared: 10, control: 10, peripheral: 10 });
    expect(corePeriphery.coreShare).toBeCloseTo(6 / 36, 10);
    // Reachable pairs: core 6×16, control 10×17, shared 10×1, periph 10×1.
    expect(report.propagationCost).toBeCloseTo((96 + 170 + 10 + 10) / 36 ** 2, 10);
  });

  it("keeps an acyclic file out of the core even when it is highly visible both ways", () => {
    // 10 controls → one hub → 10 shared, plus 10 isolated files: the hub clears
    // both bimodal cuts, but a core is a cyclic group (MacCormack) — an acyclic
    // crossroad is the waist of a hierarchy, not its core.
    const control = range("control", 10);
    const shared = range("shared", 10);
    const periph = range("periph", 10);
    const graph: FileDependencyGraph = {
      files: [...control, "hub.ts", ...shared, ...periph].map(file),
      edges: [...control.map((f) => edge(f, "hub.ts")), ...shared.map((f) => edge("hub.ts", f))],
    };
    const { corePeriphery } = computePropagationCost(graph);
    expect(corePeriphery.visibilityFanIn.method).toBe("otsu");
    expect(corePeriphery.visibilityFanOut.method).toBe("otsu");
    expect(corePeriphery.counts).toEqual({ core: 0, shared: 10, control: 10, peripheral: 10 });
    expect(corePeriphery.acyclicHighVisibilityFileCount).toBe(1);
    expect(corePeriphery.shape).toBe("hierarchical");
  });

  it("falls back to the median cut and calls the shape indeterminate when visibility is not bimodal", () => {
    const graph: FileDependencyGraph = {
      files: ["a.ts", "b.ts", "c.ts"].map(file),
      edges: [edge("a.ts", "b.ts"), edge("b.ts", "c.ts")],
    };
    const { corePeriphery } = computePropagationCost(graph);
    expect(corePeriphery.shape).toBe("indeterminate");
    expect(corePeriphery.visibilityFanOut).toMatchObject({ method: "majority", threshold: 2 });
    expect(corePeriphery.counts).toEqual({ core: 0, shared: 1, control: 1, peripheral: 1 });
  });

  it("calls the shape indeterminate when a cut is floored even though a cyclic group clears both floors", () => {
    // Ring a ⇄ b, a → e, c → a, plus three isolated files: 7 files, below the
    // Otsu population, so both cuts are the median floor. The ring sits above
    // both medians and would be a core, but a floored cut is no evidence of a
    // core-periphery split — nor of its absence.
    const graph: FileDependencyGraph = {
      files: ["a.ts", "b.ts", "c.ts", "e.ts", "p1.ts", "p2.ts", "p3.ts"].map(file),
      edges: [edge("a.ts", "b.ts"), edge("b.ts", "a.ts"), edge("a.ts", "e.ts"), edge("c.ts", "a.ts")],
    };
    const { corePeriphery } = computePropagationCost(graph);
    expect(corePeriphery.visibilityFanIn.method).toBe("majority");
    expect(corePeriphery.visibilityFanOut.method).toBe("majority");
    expect(corePeriphery.counts.core).toBe(2);
    expect(corePeriphery.shape).toBe("indeterminate");
  });

  it("breaks the cost down per component: internal closure density, system reach, core files", () => {
    const graph = corePeripheryGraph();
    const report = computePropagationCost(graph, { componentOf: componentOfDir(graph) });
    const byComponent = new Map(report.components.map((c) => [c.component, c]));
    expect(byComponent.get("core/")).toEqual({
      component: "core/",
      fileCount: 6,
      propagationCost: 1,
      meanReach: 16 / 36,
      coreFileCount: 6,
    });
    expect(byComponent.get("control/")?.propagationCost).toBeCloseTo(10 / 100, 10);
    expect(byComponent.get("shared/")?.meanReach).toBeCloseTo(17 / 36, 10);
    // Ordered by system reach, largest first.
    expect(report.components.map((c) => c.component)).toEqual(["shared/", "core/", "control/", "periph/"]);
  });
});
