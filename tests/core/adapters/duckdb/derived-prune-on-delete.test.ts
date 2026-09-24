import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import { computeAndPersistCyclesAndSignals } from "../../../../src/core/adapters/duckdb/daemon/graph-analysis.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/domains/maintenance/migration/database/runner.js";

/**
 * bd tea-rags-mcp-dy852 — a deletion-only reindex prunes the BASE graph tables
 * and never recomputes the DERIVED ones, so `find_cycles` kept serving a cycle
 * whose member's file is gone and `cg_symbols_metrics` kept ranks for deleted
 * declarations.
 *
 * The owner-decided fix is a cheap prune, not a recompute: drop every cycle
 * with a member in a deleted file, drop the deleted files' ranks, and mark the
 * derived tables stale so the next run recomputes them. A full recompute
 * (whose last write is `replacePageRanks`) clears the mark.
 */
describe("derived-table prune on file deletion (dy852)", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-derived-prune-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
    await runMigrations(db, DATABASE_MIGRATIONS);
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** `symA` in `pathA` ↔ `symB` in `pathB`, as both a file and a method cycle. */
  async function crossFileCycle(symA: string, pathA: string, symB: string, pathB: string): Promise<void> {
    await db.upsertFile(
      { relPath: pathA, language: "typescript" },
      {
        fileEdges: [{ targetRelPath: pathB, importText: `./${pathB}` }],
        methodEdges: [{ sourceSymbolId: symA, targetSymbolId: symB, targetRelPath: pathB, callExpression: "b()" }],
      },
    );
    await db.upsertFile(
      { relPath: pathB, language: "typescript" },
      {
        fileEdges: [{ targetRelPath: pathA, importText: `./${pathA}` }],
        methodEdges: [{ sourceSymbolId: symB, targetSymbolId: symA, targetRelPath: pathA, callExpression: "a()" }],
      },
    );
  }

  it("drops every cycle touching a deleted file and that file's ranks, and marks the tables stale", async () => {
    await crossFileCycle("A.x", "src/a.ts", "B.y", "src/b.ts");
    await crossFileCycle("C.x", "src/c.ts", "D.y", "src/d.ts");
    await computeAndPersistCyclesAndSignals(db);
    expect(await db.findCycles("method")).toHaveLength(2);
    expect(await db.findCycles("file")).toHaveLength(2);
    expect(await db.hasStaleDerivedTables()).toBe(false);

    await db.pruneDerivedForDeletedFiles(["src/a.ts"]);

    const method = await db.findCycles("method");
    expect(method.map((c) => c.members.slice().sort())).toEqual([["C.x", "D.y"]]);
    const file = await db.findCycles("file");
    expect(file.map((c) => c.members.slice().sort())).toEqual([["src/c.ts", "src/d.ts"]]);
    const rankedPaths = await db.queryAll<{ rel_path: string }>(
      "SELECT DISTINCT rel_path FROM cg_symbols_metrics ORDER BY rel_path",
    );
    expect(rankedPaths.map((r) => r.rel_path)).toEqual(["src/b.ts", "src/c.ts", "src/d.ts"]);
    expect(await db.hasStaleDerivedTables()).toBe(true);
  });

  it("a full recompute clears the stale mark", async () => {
    await crossFileCycle("A.x", "src/a.ts", "B.y", "src/b.ts");
    await db.pruneDerivedForDeletedFiles(["src/a.ts"]);
    expect(await db.hasStaleDerivedTables()).toBe(true);

    await computeAndPersistCyclesAndSignals(db);

    expect(await db.hasStaleDerivedTables()).toBe(false);
  });

  it("is a no-op for an empty path list — nothing marked stale", async () => {
    await db.pruneDerivedForDeletedFiles([]);
    expect(await db.hasStaleDerivedTables()).toBe(false);
  });

  it("does not mark the tables stale for a path the graph never walked (a deleted README)", async () => {
    await crossFileCycle("A.x", "src/a.ts", "B.y", "src/b.ts");
    await computeAndPersistCyclesAndSignals(db);

    await db.pruneDerivedForDeletedFiles(["README.md"]);

    expect(await db.hasStaleDerivedTables()).toBe(false);
    expect(await db.findCycles("method")).toHaveLength(1);
  });
});
