import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/domains/maintenance/migration/database/runner.js";

// bd tea-rags-mcp-a2ddb — the derived codegraph signals of a symbol move every
// time the graph around it moves, file change or not. `diffSymbolSignals`
// names what moved since the previous run's `refreshSymbolSignalsPrev`; the
// payload healer rewrites exactly those points.
describe("DuckDbGraphClient symbol/file signal drift diff", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-signals-diff-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
    await runMigrations(db, DATABASE_MIGRATIONS);
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function seedSymbol(relPath: string, symbolId: string): Promise<void> {
    await db.run("INSERT INTO cg_symbols_files (rel_path, language) VALUES (?, 'typescript')", [relPath]);
    await db.run(
      "INSERT INTO cg_symbols (rel_path, symbol_id, fq_name, short_name, scope_json) VALUES (?, ?, ?, ?, '{}')",
      [relPath, symbolId, symbolId, symbolId],
    );
  }

  async function addMethodEdge(source: string, sourcePath: string, target: string, targetPath: string): Promise<void> {
    await db.run(
      `INSERT INTO cg_symbols_edges_method
         (source_symbol_id, source_rel_path, target_symbol_id, target_rel_path, call_expression, edge_kind, confidence)
       VALUES (?, ?, ?, ?, ?, 'exact', 1.0)`,
      [source, sourcePath, target, targetPath, `${target}()`],
    );
  }

  it("reports every symbol on the first diff, then only the ones whose signals moved", async () => {
    await seedSymbol("a.ts", "A");
    await seedSymbol("b.ts", "B");
    await addMethodEdge("A", "a.ts", "B", "b.ts");

    // Empty prev tables ⇒ the first run heals every point once.
    const first = await db.diffSymbolSignals();
    expect(first.symbols.map((s) => s.symbolId).sort()).toEqual(["A", "B"]);

    await db.refreshSymbolSignalsPrev();
    expect(await db.diffSymbolSignals()).toEqual({ symbols: [], files: [] });

    // A second caller of B: B's fanIn moved, A's signals did not.
    await seedSymbol("c.ts", "C");
    await addMethodEdge("C", "c.ts", "B", "b.ts");

    const second = await db.diffSymbolSignals();
    // C is new (absent from prev); B moved. A is unchanged and must stay out.
    expect(second.symbols.map((s) => s.symbolId).sort()).toEqual(["B", "C"]);
    expect(second.symbols.find((s) => s.symbolId === "B")?.relPath).toBe("b.ts");

    await db.refreshSymbolSignalsPrev();
    expect((await db.diffSymbolSignals()).symbols).toEqual([]);
  });

  it("detects a pageRank move with no edge change at all", async () => {
    await seedSymbol("a.ts", "A");
    await db.refreshSymbolSignalsPrev();
    expect((await db.diffSymbolSignals()).symbols).toEqual([]);

    await db.replacePageRanks(new Map([["A", 0.25]]));
    const moved = await db.diffSymbolSignals();
    expect(moved.symbols).toEqual([{ relPath: "a.ts", symbolId: "A" }]);
  });

  it("detects a confidence-only fan move that an edge COUNT would miss", async () => {
    await seedSymbol("a.ts", "A");
    await seedSymbol("b.ts", "B");
    await addMethodEdge("A", "a.ts", "B", "b.ts");
    await db.refreshSymbolSignalsPrev();
    expect((await db.diffSymbolSignals()).symbols).toEqual([]);

    // Same row count, different dispatch confidence — the payload's
    // confidence-weighted fanIn changes, so the point must be healed.
    await db.run("UPDATE cg_symbols_edges_method SET confidence = 0.25 WHERE target_symbol_id = 'B'");
    const moved = await db.diffSymbolSignals();
    expect(moved.symbols.map((s) => s.symbolId).sort()).toEqual(["A", "B"]);
  });

  it("reports file-level fan drift against cg_file_signals_prev", async () => {
    await seedSymbol("hub.ts", "Hub");
    await seedSymbol("leaf.ts", "Leaf");
    await db.run("INSERT INTO cg_symbols_edges_file (source_rel_path, target_rel_path, import_text) VALUES (?, ?, ?)", [
      "leaf.ts",
      "hub.ts",
      "./hub",
    ]);

    const first = await db.diffSymbolSignals();
    expect(first.files.map((f) => f.relPath).sort()).toEqual(["hub.ts", "leaf.ts"]);

    await db.refreshSymbolSignalsPrev();
    expect((await db.diffSymbolSignals()).files).toEqual([]);

    await seedSymbol("other.ts", "Other");
    await db.run("INSERT INTO cg_symbols_edges_file (source_rel_path, target_rel_path, import_text) VALUES (?, ?, ?)", [
      "other.ts",
      "hub.ts",
      "./hub",
    ]);

    const second = await db.diffSymbolSignals();
    // hub.ts gained fanIn, other.ts is new; leaf.ts is untouched.
    expect(second.files.map((f) => f.relPath).sort()).toEqual(["hub.ts", "other.ts"]);
  });

  it("keeps the prev tables in step with the current graph after a refresh", async () => {
    await seedSymbol("a.ts", "A");
    await db.refreshSymbolSignalsPrev();
    await db.run("DELETE FROM cg_symbols WHERE symbol_id = 'A'");
    await db.run("DELETE FROM cg_symbols_files WHERE rel_path = 'a.ts'");
    await db.refreshSymbolSignalsPrev();

    const symbols = await db.queryAll<{ n: number }>("SELECT COUNT(*) AS n FROM cg_symbol_signals_prev");
    const files = await db.queryAll<{ n: number }>("SELECT COUNT(*) AS n FROM cg_file_signals_prev");
    expect(Number(symbols[0]?.n ?? -1)).toBe(0);
    expect(Number(files[0]?.n ?? -1)).toBe(0);
  });
});
