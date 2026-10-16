import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import { fileScopedSymbolKey } from "../../../../src/core/contracts/types/codegraph.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/domains/maintenance/migration/database/runner.js";

/**
 * bd tea-rags-mcp-2m83f.40 — find_cycles marks the cycles a residual model
 * closes. A cycle carries `hasModelEdge` and `modelEdgeCount` (its member-to-
 * member hops only model edges support) read from the edge table at query time;
 * an all-static cycle carries neither.
 */
describe("DuckDbGraphClient — findCycles model provenance (2m83f.40)", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  const edge = (sourceSymbolId: string, targetSymbolId: string, callExpression: string) => ({
    sourceSymbolId,
    targetSymbolId,
    targetRelPath: `${targetSymbolId[0].toLowerCase()}.rb`,
    callExpression,
    edgeKind: "exact" as const,
    confidence: 1,
  });
  const markModel = async (callExpression: string) =>
    db.run("UPDATE cg_symbols_edges_method SET origin = 'model', model = 'kev', p = 0.8 WHERE call_expression = ?", [
      callExpression,
    ]);
  const vertex = (symbolId: string) => fileScopedSymbolKey({ relPath: `${symbolId[0].toLowerCase()}.rb`, symbolId });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-cycles-model-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
    await runMigrations(db, DATABASE_MIGRATIONS);
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("method scope: counts the hops only model edges support", async () => {
    await db.upsertFile(
      { relPath: "a.rb", language: "ruby" },
      {
        fileEdges: [],
        methodEdges: [
          edge("A#a", "A#b", "a_to_b"),
          edge("A#b", "A#a", "b_to_a_model"),
          // A hop a static site also supports stays static.
          edge("A#b", "A#c", "b_to_c_static"),
          edge("A#b", "A#c", "b_to_c_model"),
          edge("A#c", "A#a", "c_to_a"),
        ],
      },
    );
    await db.upsertFile(
      { relPath: "s.rb", language: "ruby" },
      { fileEdges: [], methodEdges: [edge("S#x", "S#y", "x_to_y"), edge("S#y", "S#x", "y_to_x")] },
    );
    await markModel("b_to_a_model");
    await markModel("b_to_c_model");
    await db.replaceCycles("method", [
      [vertex("A#a"), vertex("A#b"), vertex("A#c")],
      [vertex("S#x"), vertex("S#y")],
    ]);

    const cycles = await db.findCycles("method");

    expect(cycles[0]).toMatchObject({ cycleId: 0, hasModelEdge: true, modelEdgeCount: 1 });
    expect(cycles[1]).not.toHaveProperty("hasModelEdge");
    expect(cycles[1]).not.toHaveProperty("modelEdgeCount");
  });

  it("file scope: counts the model-only file edges inside the cycle", async () => {
    await db.upsertFile(
      { relPath: "a.rb", language: "ruby" },
      { fileEdges: [{ targetRelPath: "b.rb", importText: "b" }], methodEdges: [] },
    );
    await db.upsertFile(
      { relPath: "b.rb", language: "ruby" },
      { fileEdges: [{ targetRelPath: "a.rb", importText: "a" }], methodEdges: [] },
    );
    await db.run("UPDATE cg_symbols_edges_file SET origin = 'model' WHERE source_rel_path = 'b.rb'");
    await db.replaceCycles("file", [["a.rb", "b.rb"]]);

    expect(await db.findCycles("file")).toEqual([
      { cycleId: 0, scope: "file", members: ["a.rb", "b.rb"], hasModelEdge: true, modelEdgeCount: 1 },
    ]);
  });
});
