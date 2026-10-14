/**
 * `WiredExportTableReader` (bd tea-rags-mcp-89k7k.1.19.6): the production
 * export table the remedy resolver reads — the facade surface from the
 * facade-contract port, the declaring file of a name from the indexed file
 * edges' recorded export names.
 */
import { describe, expect, it } from "vitest";

import { WiredExportTableReader } from "../../../../../../src/core/api/internal/ops/review-sections/wired-export-table-reader.js";
import type { FileDependencyEdge } from "../../../../../../src/core/contracts/types/codegraph.js";
import { ReviewEdgeOverlay } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/index.js";

function edge(
  sourceRelPath: string,
  targetRelPath: string,
  names: { imported?: string[]; reexported?: string[] } = {},
): FileDependencyEdge {
  return {
    sourceRelPath,
    targetRelPath,
    callWeight: 1,
    ...(names.imported !== undefined ? { importedExportNames: names.imported } : {}),
    ...(names.reexported !== undefined ? { reexportedExportNames: names.reexported } : {}),
  };
}

const NO_SURFACE = { indexedSurfaceOf: () => undefined };

describe("WiredExportTableReader", () => {
  it("serves the facade surface from the facade-contract port — one reading, never a second", () => {
    const reader = new WiredExportTableReader(
      { indexedSurfaceOf: (facade) => (facade === "src/lib/index.ts" ? ["a"] : undefined) },
      [],
    );
    expect(reader.indexedSurfaceOf("src/lib/index.ts")).toEqual(["a"]);
    expect(reader.indexedSurfaceOf("src/lib/x.ts")).toBeUndefined();
  });

  it("a file an import takes the name from, re-exporting nothing of it, declares the name", () => {
    const reader = new WiredExportTableReader(NO_SURFACE, [edge("src/app/a.ts", "src/lib/x.ts", { imported: ["X"] })]);
    expect(reader.declarersOf("X")).toEqual(["src/lib/x.ts"]);
  });

  it("follows re-export chains to the file at their end — a barrel forwarding the name declares nothing", () => {
    const reader = new WiredExportTableReader(NO_SURFACE, [
      edge("src/app/a.ts", "src/lib/index.ts", { imported: ["X"] }),
      edge("src/lib/index.ts", "src/lib/inner/index.ts", { reexported: ["X"] }),
      edge("src/lib/inner/index.ts", "src/lib/inner/x.ts", { reexported: ["X"] }),
    ]);
    expect(reader.declarersOf("X")).toEqual(["src/lib/inner/x.ts"]);
  });

  it("lists every declaring file of a name two files declare", () => {
    const reader = new WiredExportTableReader(NO_SURFACE, [
      edge("src/app/a.ts", "src/lib/x.ts", { imported: ["X"] }),
      edge("src/app/b.ts", "src/other/x.ts", { imported: ["X"] }),
    ]);
    expect(reader.declarersOf("X")).toEqual(["src/lib/x.ts", "src/other/x.ts"]);
  });

  it("answers undefined for a name no recorded edge names — a missing fact, never 'no declarer'", () => {
    const reader = new WiredExportTableReader(NO_SURFACE, [edge("src/app/a.ts", "src/lib/x.ts")]);
    expect(reader.declarersOf("X")).toBeUndefined();
  });

  it("answers undefined when a candidate re-exports a whole module — it may forward the name, unrecorded", () => {
    const reader = new WiredExportTableReader(NO_SURFACE, [
      edge("src/app/a.ts", "src/lib/index.ts", { imported: ["X"] }),
      edge("src/lib/index.ts", "src/lib/x.ts", { reexported: ["*"] }),
    ]);
    expect(reader.declarersOf("X")).toBeUndefined();
  });
  describe("through the review overlay (bd tea-rags-mcp-if14t)", () => {
    it("A: a name held only by the overlay's edges of a changed file is declared by that edge's target", () => {
      const overlay = new ReviewEdgeOverlay([
        { relPath: "src/app/a.ts", edges: [edge("src/app/a.ts", "src/lib/new.ts", { imported: ["Fresh"] })] },
      ]);
      const reader = new WiredExportTableReader(NO_SURFACE, [], overlay);
      expect(reader.declarersOf("Fresh")).toEqual(["src/lib/new.ts"]);
    });

    it("B: a changed source's stale indexed edge is replaced by its overlay edges", () => {
      const overlay = new ReviewEdgeOverlay([
        { relPath: "src/app/a.ts", edges: [edge("src/app/a.ts", "src/lib/moved.ts", { imported: ["X"] })] },
      ]);
      const reader = new WiredExportTableReader(
        NO_SURFACE,
        [edge("src/app/a.ts", "src/lib/old.ts", { imported: ["X"] })],
        overlay,
      );
      expect(reader.declarersOf("X")).toEqual(["src/lib/moved.ts"]);
    });

    it("C: a skipped read keeps the source's indexed edges — a missing fact is never 'no edge'", () => {
      const overlay = new ReviewEdgeOverlay([{ relPath: "src/app/a.ts", edges: [], skip: { reason: "parseFailed" } }]);
      const reader = new WiredExportTableReader(
        NO_SURFACE,
        [edge("src/app/a.ts", "src/lib/x.ts", { imported: ["X"] })],
        overlay,
      );
      expect(reader.declarersOf("X")).toEqual(["src/lib/x.ts"]);
    });

    it("D: sources the overlay does not mask keep their indexed edges", () => {
      const overlay = new ReviewEdgeOverlay([{ relPath: "src/app/other.ts", edges: [] }]);
      const reader = new WiredExportTableReader(
        NO_SURFACE,
        [edge("src/app/a.ts", "src/lib/x.ts", { imported: ["X"] })],
        overlay,
      );
      expect(reader.declarersOf("X")).toEqual(["src/lib/x.ts"]);
    });

    it("E: a re-read facade's surface is the names its overlay edges re-export, not the indexed ones", () => {
      const overlay = new ReviewEdgeOverlay([
        {
          relPath: "src/lib/index.ts",
          edges: [edge("src/lib/index.ts", "src/lib/x.ts", { reexported: ["a", "fresh"] })],
        },
      ]);
      const reader = new WiredExportTableReader(
        { indexedSurfaceOf: () => ["a", "dropped"] },
        [edge("src/lib/index.ts", "src/lib/x.ts", { reexported: ["a", "dropped"] })],
        overlay,
      );
      expect(reader.indexedSurfaceOf("src/lib/index.ts")).toEqual(["a", "fresh"]);
    });

    it("F: a facade the overlay did not re-read, or whose read was skipped, keeps the contract's surface", () => {
      const overlay = new ReviewEdgeOverlay([
        { relPath: "src/lib/skipped.ts", edges: [], skip: { reason: "parseFailed" } },
      ]);
      const reader = new WiredExportTableReader({ indexedSurfaceOf: () => ["a"] }, [], overlay);
      expect(reader.indexedSurfaceOf("src/lib/index.ts")).toEqual(["a"]);
      expect(reader.indexedSurfaceOf("src/lib/skipped.ts")).toEqual(["a"]);
    });

    it("G: a re-read facade whose overlay edges record no re-export names keeps the contract's surface", () => {
      const overlay = new ReviewEdgeOverlay([{ relPath: "src/lib/index.ts", edges: [] }]);
      const reader = new WiredExportTableReader({ indexedSurfaceOf: () => ["a"] }, [], overlay);
      expect(reader.indexedSurfaceOf("src/lib/index.ts")).toEqual(["a"]);
    });
  });

  describe("files the diff deleted (bd tea-rags-mcp-ah66x)", () => {
    it("a deleted file is not a declarer — the indexed import into it does not hold the name there", () => {
      const overlay = new ReviewEdgeOverlay(
        [{ relPath: "src/app/b.ts", edges: [edge("src/app/b.ts", "src/lib/new.ts", { imported: ["X"] })] }],
        { deleted: ["src/lib/old.ts"] },
      );
      const reader = new WiredExportTableReader(
        NO_SURFACE,
        [edge("src/app/a.ts", "src/lib/old.ts", { imported: ["X"] })],
        overlay,
      );
      expect(reader.declarersOf("X")).toEqual(["src/lib/new.ts"]);
    });

    it("a deleted whole-module re-exporter is not a declarer and no longer hides the real one", () => {
      const overlay = new ReviewEdgeOverlay(
        [{ relPath: "src/app/b.ts", edges: [edge("src/app/b.ts", "src/lib/impl.ts", { imported: ["X"] })] }],
        { deleted: ["src/lib/index.ts"] },
      );
      const reader = new WiredExportTableReader(
        NO_SURFACE,
        [
          edge("src/app/a.ts", "src/lib/index.ts", { imported: ["X"] }),
          edge("src/lib/index.ts", "src/lib/other.ts", { reexported: ["*"] }),
        ],
        overlay,
      );
      expect(reader.declarersOf("X")).toEqual(["src/lib/impl.ts"]);
    });
  });
});
