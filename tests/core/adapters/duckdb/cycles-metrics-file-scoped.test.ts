import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import { computeAndPersistCyclesAndSignals } from "../../../../src/core/adapters/duckdb/daemon/graph-analysis.js";
import { fileScopedSymbolKey } from "../../../../src/core/contracts/types/codegraph.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/domains/maintenance/migration/database/runner.js";

/**
 * bd tea-rags-mcp-4g9ga — method-scope cycles and PageRank are keyed by
 * `(rel_path, symbol_id)`, not by the bare symbol id.
 *
 * A `SymbolId` is unique per FILE, so keying the method graph on the bare id
 * merged every namesake into ONE node: two Go `init()` functions in different
 * files of one package (bd tea-rags-mcp-4400) collapsed into a single vertex,
 * which glued two unrelated two-node cycles into one three-node SCC, and every
 * top-level `main` shared one merged PageRank.
 *
 * Driven through `computeAndPersistCyclesAndSignals` — the daemon route's
 * recompute. The inline route (`GraphBuildFinalizer#recomputeMetrics`) drains
 * the same `streamAdjacency` into the same Tarjan / PageRank and persists
 * through the same `replaceCycles` / `replacePageRanks`.
 */
describe("method-scope cycles and PageRank are file-scoped (4g9ga)", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-file-scoped-derived-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
    await runMigrations(db, DATABASE_MIGRATIONS);
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** `init ↔ helper` inside one file of package `pkg`. */
  async function initCycleIn(relPath: string, helper: string): Promise<void> {
    await db.upsertFile(
      { relPath, language: "go" },
      {
        fileEdges: [],
        methodEdges: [
          { sourceSymbolId: "init", targetSymbolId: helper, targetRelPath: relPath, callExpression: `${helper}()` },
          { sourceSymbolId: helper, targetSymbolId: "init", targetRelPath: relPath, callExpression: "init()" },
        ],
      },
    );
  }

  it("two Go init() namesakes in one package stay two cycles, each member carrying its file", async () => {
    await initCycleIn("pkg/a.go", "registerA");
    await initCycleIn("pkg/b.go", "registerB");

    await computeAndPersistCyclesAndSignals(db);

    const cycles = await db.findCycles("method");
    const shapes = cycles
      .map((c) =>
        (c.memberLocations ?? [])
          .map((m) => `${m.relativePath}|${m.symbolId}`)
          .slice()
          .sort(),
      )
      .sort((x, y) => x[0].localeCompare(y[0]));
    expect(shapes).toEqual([
      ["pkg/a.go|init", "pkg/a.go|registerA"],
      ["pkg/b.go|init", "pkg/b.go|registerB"],
    ]);
    // `members` keeps the bare symbol ids — the additive field is the only change.
    for (const c of cycles) {
      expect(c.members).toEqual((c.memberLocations ?? []).map((m) => m.symbolId));
    }
  });

  it("filters a method cycle by its members' OWN files, not by resolving the name", async () => {
    await initCycleIn("pkg/a.go", "registerA");
    await initCycleIn("pkg/b.go", "registerB");
    await computeAndPersistCyclesAndSignals(db);

    // Resolving the bare name `init` back to files answers both a.go and b.go,
    // which would keep b.go's cycle under an a.go pattern.
    const scoped = await db.findCycles("method", "pkg/a.go");
    expect(scoped).toHaveLength(1);
    expect(scoped[0].members.slice().sort()).toEqual(["init", "registerA"]);
  });

  it("file-scope cycles are unchanged: members are paths, no memberLocations", async () => {
    await db.upsertFile(
      { relPath: "src/a.ts", language: "typescript" },
      { fileEdges: [{ targetRelPath: "src/b.ts", importText: "./b" }], methodEdges: [] },
    );
    await db.upsertFile(
      { relPath: "src/b.ts", language: "typescript" },
      { fileEdges: [{ targetRelPath: "src/a.ts", importText: "./a" }], methodEdges: [] },
    );
    await computeAndPersistCyclesAndSignals(db);

    const cycles = await db.findCycles("file");
    expect(cycles).toHaveLength(1);
    expect(cycles[0].members.slice().sort()).toEqual(["src/a.ts", "src/b.ts"]);
    expect(cycles[0].memberLocations).toBeUndefined();
    expect(await db.findCycles("file", "src/b.ts")).toHaveLength(1);
  });

  it("ranks each namesake `main` over its own edges, not one merged node", async () => {
    // cmd/x.go#main is called by three helpers; cmd/y.go#main is called by nobody.
    await db.upsertFile(
      { relPath: "cmd/callers.go", language: "go" },
      {
        fileEdges: [],
        methodEdges: ["c1", "c2", "c3"].map((c) => ({
          sourceSymbolId: c,
          targetSymbolId: "main",
          targetRelPath: "cmd/x.go",
          callExpression: "main()",
        })),
      },
    );
    await db.upsertFile(
      { relPath: "cmd/y.go", language: "go" },
      {
        fileEdges: [],
        methodEdges: [
          { sourceSymbolId: "main", targetSymbolId: "run", targetRelPath: "cmd/run.go", callExpression: "run()" },
        ],
      },
    );
    await computeAndPersistCyclesAndSignals(db);

    const x = await db.getPageRank("main", "cmd/x.go");
    const y = await db.getPageRank("main", "cmd/y.go");
    expect(x).toBeGreaterThan(y);
    expect(y).toBeGreaterThan(0);

    const bulk = await db.getChunkSignalsBulk();
    expect(bulk.get(fileScopedSymbolKey({ relPath: "cmd/x.go", symbolId: "main" }))?.pageRank).toBeCloseTo(x, 12);
    expect(bulk.get(fileScopedSymbolKey({ relPath: "cmd/y.go", symbolId: "main" }))?.pageRank).toBeCloseTo(y, 12);

    const rows = await db.queryAll<{ rel_path: string; symbol_id: string }>(
      "SELECT rel_path, symbol_id FROM cg_symbols_metrics WHERE symbol_id = 'main' ORDER BY rel_path",
    );
    expect(rows).toEqual([
      { rel_path: "cmd/x.go", symbol_id: "main" },
      { rel_path: "cmd/y.go", symbol_id: "main" },
    ]);
  });
});
