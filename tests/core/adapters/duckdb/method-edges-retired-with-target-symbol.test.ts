/**
 * A method edge dies with the symbol it points at (epic tea-rags-mcp-4p3sb).
 *
 * Invariant: no row outlives its source. `cg_symbols_edges_method` rows are
 * reconciled per SOURCE file, so a call from an unchanged file into a method
 * that was removed from a still-present file was never revisited: the caller is
 * not re-walked, and `upsertSymbolsBulk` only diffed `cg_symbols`. The edge kept
 * pointing at the dead `(target_rel_path, target_symbol_id)`, `get_callees`
 * kept answering it, and PageRank — which takes its vertices from the edge
 * table — kept a rank for the dead symbol in `cg_symbols_metrics`.
 *
 * `removeFile` already drops the incoming edges of a DELETED file (`OR
 * target_rel_path = ?`); this is the same rule for a symbol that left a file
 * which is still there. Only the rows the `cg_symbols` diff actually deletes are
 * followed into the edge table, so an edge whose target never had a symbol row
 * (an external or DSL-synthesised target, a NULL target) is not touched.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import type { SymbolDefinition } from "../../../../src/core/contracts/types/codegraph.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/domains/maintenance/migration/database/runner.js";

function def(relPath: string, symbolId: string): SymbolDefinition {
  return { relPath, symbolId, fqName: symbolId, shortName: symbolId.split(/[#.]/).pop() ?? symbolId, scope: [] };
}

describe("DuckDbGraphClient.upsertSymbolsBulk — incoming method edges of a removed symbol", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-edge-retire-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
    await runMigrations(db, DATABASE_MIGRATIONS);
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function edgeTargets(): Promise<string[]> {
    const rows = await db.queryAll<{ t: string }>(
      `SELECT source_rel_path || ' ' || source_symbol_id || ' -> ' || coalesce(target_rel_path, '-') || ' ' ||
              coalesce(target_symbol_id, '-') AS t FROM cg_symbols_edges_method ORDER BY t`,
    );
    return rows.map((r) => r.t);
  }

  /** `src/b.rb` (never re-walked) calls `Alpha#doomed` and `Alpha#keep` in `src/a.rb`, and an external. */
  async function seed(): Promise<void> {
    await db.upsertSymbolsBulk([
      { relPath: "src/a.rb", definitions: [def("src/a.rb", "Alpha#keep"), def("src/a.rb", "Alpha#doomed")] },
      { relPath: "src/b.rb", definitions: [def("src/b.rb", "Beta.go")] },
      // A namesake in another file: same symbolId, different rel_path.
      { relPath: "src/c.rb", definitions: [def("src/c.rb", "Alpha#doomed")] },
    ]);
    await db.upsertFile(
      { relPath: "src/b.rb", language: "ruby" },
      {
        fileEdges: [],
        methodEdges: [
          {
            sourceSymbolId: "Beta.go",
            targetSymbolId: "Alpha#doomed",
            targetRelPath: "src/a.rb",
            callExpression: "a.doomed",
          },
          {
            sourceSymbolId: "Beta.go",
            targetSymbolId: "Alpha#keep",
            targetRelPath: "src/a.rb",
            callExpression: "a.keep",
          },
          {
            sourceSymbolId: "Beta.go",
            targetSymbolId: "Alpha#doomed",
            targetRelPath: "src/c.rb",
            callExpression: "c.doomed",
          },
          { sourceSymbolId: "Beta.go", targetSymbolId: null, targetRelPath: "src/a.rb", callExpression: "Alpha.new" },
        ],
      },
    );
  }

  it("drops the edge from an unchanged caller into a method removed from a still-present file", async () => {
    await seed();

    await db.upsertSymbolsBulk([{ relPath: "src/a.rb", definitions: [def("src/a.rb", "Alpha#keep")] }]);

    expect(await edgeTargets()).toEqual([
      "src/b.rb Beta.go -> src/a.rb -",
      "src/b.rb Beta.go -> src/a.rb Alpha#keep",
      "src/b.rb Beta.go -> src/c.rb Alpha#doomed",
    ]);
  });

  it("drops every incoming edge when the file keeps no declarations at all, and keeps the NULL-target edge", async () => {
    await seed();

    await db.upsertSymbolsBulk([{ relPath: "src/a.rb", definitions: [] }]);

    expect(await edgeTargets()).toEqual([
      "src/b.rb Beta.go -> src/a.rb -",
      "src/b.rb Beta.go -> src/c.rb Alpha#doomed",
    ]);
  });

  it("leaves every edge alone when the re-walked file declares the same symbols", async () => {
    await seed();
    const before = await edgeTargets();

    await db.upsertSymbolsBulk([
      { relPath: "src/a.rb", definitions: [def("src/a.rb", "Alpha#keep"), def("src/a.rb", "Alpha#doomed")] },
    ]);

    expect(await edgeTargets()).toEqual(before);
  });
});
