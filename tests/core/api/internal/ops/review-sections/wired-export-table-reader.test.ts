/**
 * `WiredExportTableReader` (bd tea-rags-mcp-89k7k.1.19.6): the production
 * export table the remedy resolver reads — the facade surface from the
 * facade-contract port, the declaring file of a name from the indexed file
 * edges' recorded export names.
 */
import { describe, expect, it } from "vitest";

import { WiredExportTableReader } from "../../../../../../src/core/api/internal/ops/review-sections/wired-export-table-reader.js";
import type { FileDependencyEdge } from "../../../../../../src/core/contracts/types/codegraph.js";

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
});
