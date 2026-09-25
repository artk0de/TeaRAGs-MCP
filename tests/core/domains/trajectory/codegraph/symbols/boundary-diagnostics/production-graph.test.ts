/**
 * The production graph the boundary detectors judge (bd tea-rags-mcp-r8hme.9):
 * the file dependency graph with every non-production file, and every edge
 * touching one, taken out before any detector counts a fan.
 */
import { describe, expect, it } from "vitest";

import type { FileDependencyGraph } from "../../../../../../../src/core/contracts/types/codegraph.js";
import {
  excludeNonProductionFiles,
  NON_PRODUCTION_REASON,
} from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/boundary-diagnostics/index.js";

function file(relPath: string) {
  return { relPath, language: "typescript", symbolCount: 1 };
}

function edge(sourceRelPath: string, targetRelPath: string) {
  return { sourceRelPath, targetRelPath, callWeight: 1 };
}

describe("excludeNonProductionFiles", () => {
  const graph: FileDependencyGraph = {
    files: [file("src/a.ts"), file("src/b.ts"), file("scripts/spikes/probe.ts"), file("scripts/report.ts")],
    edges: [
      edge("src/a.ts", "src/b.ts"),
      edge("scripts/spikes/probe.ts", "src/b.ts"),
      edge("scripts/report.ts", "scripts/spikes/probe.ts"),
      // An unwalked endpoint is classified by its path like any other.
      edge("src/a.ts", "scripts/gen/unwalked.ts"),
    ],
  };

  it("drops non-production files and every edge touching one, and counts both", () => {
    const production = excludeNonProductionFiles(graph);

    expect(production.graph).toEqual({
      files: [file("src/a.ts"), file("src/b.ts")],
      edges: [edge("src/a.ts", "src/b.ts")],
    });
    expect(production.excludedFileCount).toBe(2);
    expect(production.excludedEdgeCount).toBe(3);
  });

  it("takes the classification as a parameter", () => {
    const production = excludeNonProductionFiles(graph, { ignores: (relPath) => relPath === "src/b.ts" });

    expect(production.graph.files.map((f) => f.relPath)).toEqual([
      "src/a.ts",
      "scripts/spikes/probe.ts",
      "scripts/report.ts",
    ]);
    expect(production.excludedEdgeCount).toBe(2);
  });

  it("names what it excludes", () => {
    expect(NON_PRODUCTION_REASON).toBe(
      "non-production path: scripts, spikes, benchmarks, examples or fixtures - tooling, not architecture",
    );
  });
});
