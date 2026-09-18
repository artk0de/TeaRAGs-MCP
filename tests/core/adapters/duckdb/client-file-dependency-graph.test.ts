/**
 * `readFileDependencyGraph` — the whole-graph read the boundary diagnostics
 * judge (bd tea-rags-mcp-thc7s).
 *
 * Invariants under test:
 *   - the edge set is `cg_symbols_edges_file` and nothing else: a call the
 *     method graph resolved across a pair with no file edge adds no edge;
 *   - each edge carries the confidence-weighted sum of the resolved calls
 *     crossing it (the weighting `codegraph.chunk.fanIn` uses), 0 when none;
 *   - an edge whose endpoint the walk never extracted is still returned — it
 *     is part of what `fanIn` / `fanOut` count;
 *   - the file universe is `cg_symbols_files`, each with its symbol count.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import type { FileDependencyEdge, SymbolDefinition } from "../../../../src/core/contracts/types/codegraph.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/domains/maintenance/migration/database/runner.js";

function def(relPath: string, symbolId: string): SymbolDefinition {
  const shortName = symbolId.split(/[#.]/).pop() ?? symbolId;
  return { symbolId, fqName: symbolId, shortName, relPath, scope: [] };
}

describe("DuckDbGraphClient — readFileDependencyGraph", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-file-dep-graph-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
    await runMigrations(db, DATABASE_MIGRATIONS);
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns every file edge weighted by the resolved calls across it, and every walked file with its symbol count", async () => {
    await db.upsertFile(
      { relPath: "src/a.ts", language: "typescript" },
      {
        fileEdges: [
          { targetRelPath: "src/b.ts", importText: "./b.js" },
          { targetRelPath: "src/c.ts", importText: "./c.js" },
          { targetRelPath: "gen/ghost.ts", importText: "../gen/ghost.js" },
        ],
        methodEdges: [
          { sourceSymbolId: "A#run", targetSymbolId: "B#x", targetRelPath: "src/b.ts", callExpression: "b.x()" },
          {
            sourceSymbolId: "A#run",
            targetSymbolId: "B#y",
            targetRelPath: "src/b.ts",
            callExpression: "b.y()",
            edgeKind: "cone",
            confidence: 0.5,
          },
          {
            sourceSymbolId: "A#go",
            targetSymbolId: "C#z",
            targetRelPath: "src/c.ts",
            callExpression: "c.z()",
            edgeKind: "dynamic",
            confidence: 0.25,
          },
          // Resolved through a re-export: the method graph reaches src/d.ts, the
          // file graph does not — this call must not invent an a → d edge.
          { sourceSymbolId: "A#go", targetSymbolId: "D#w", targetRelPath: "src/d.ts", callExpression: "d.w()" },
        ],
      },
    );
    await db.upsertFile(
      { relPath: "src/b.ts", language: "typescript" },
      { fileEdges: [{ targetRelPath: "src/c.ts", importText: "./c.js" }], methodEdges: [] },
    );
    await db.upsertFile({ relPath: "src/c.ts", language: "typescript" }, { fileEdges: [], methodEdges: [] });
    await db.upsertSymbols("src/a.ts", [def("src/a.ts", "A#run"), def("src/a.ts", "A#go")]);
    await db.upsertSymbols("src/b.ts", [def("src/b.ts", "B#x")]);

    const graph = await db.readFileDependencyGraph();

    const byPair = (x: FileDependencyEdge, y: FileDependencyEdge): number =>
      `${x.sourceRelPath}>${x.targetRelPath}`.localeCompare(`${y.sourceRelPath}>${y.targetRelPath}`);
    expect([...graph.edges].sort(byPair)).toEqual([
      { sourceRelPath: "src/a.ts", targetRelPath: "gen/ghost.ts", callWeight: 0 },
      { sourceRelPath: "src/a.ts", targetRelPath: "src/b.ts", callWeight: 1.5 },
      { sourceRelPath: "src/a.ts", targetRelPath: "src/c.ts", callWeight: 0.25 },
      { sourceRelPath: "src/b.ts", targetRelPath: "src/c.ts", callWeight: 0 },
    ]);
    expect([...graph.files].sort((x, y) => x.relPath.localeCompare(y.relPath))).toEqual([
      { relPath: "src/a.ts", language: "typescript", symbolCount: 2 },
      { relPath: "src/b.ts", language: "typescript", symbolCount: 1 },
      { relPath: "src/c.ts", language: "typescript", symbolCount: 0 },
    ]);
  });

  it("reads an empty graph as empty", async () => {
    expect(await db.readFileDependencyGraph()).toEqual({ files: [], edges: [] });
  });
});
