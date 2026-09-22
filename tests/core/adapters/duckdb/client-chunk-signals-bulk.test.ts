/**
 * `getChunkSignalsBulk` — the set-based read-back that replaces the N+1 per-chunk
 * `getCalledByCount` + `getCallSiteCount` + `getPageRank` loop in
 * `CodegraphEnrichmentProvider#buildChunkSignals` (the ~196s deferred-chunk tail).
 *
 * Equivalence invariant under test: for every symbol of a graph with NO
 * namesakes, the bulk map's {fanIn, fanOut, pageRank} is byte-identical to the
 * three per-symbol getters — same confidence-weighted
 * `SUM(COALESCE(confidence,1.0))`, same 2-decimal `roundEdgeWeightSum`
 * boundary, same `Number()`/0 default for pageRank, and a symbol absent from
 * every table reads as {0,0,0} (matching the per-symbol getters which each
 * return 0 on no rows).
 *
 * The "no namesakes" qualifier is load-bearing since bd tea-rags-mcp-xtdkq: the
 * bulk map is keyed by `(relPath, symbolId)` while the per-symbol getters still
 * group on the bare id, so the two agree only where one file declares the
 * symbol. Where several do, the getters answer the union and the bulk map does
 * not — that divergence IS the fix, and it is pinned by
 * `chunk-signals-bulk-namesake-scope.test.ts`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import { fileScopedSymbolKey, type SymbolId } from "../../../../src/core/contracts/types/codegraph.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/domains/maintenance/migration/database/runner.js";

describe("DuckDbGraphClient — getChunkSignalsBulk (deferred-chunk read-back)", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-chunk-bulk-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
    await runMigrations(db, DATABASE_MIGRATIONS);
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Seed a method graph with a mix of exact (confidence→1) and dynamic
   * (fractional confidence) edges so the confidence-weighted SUM + 2-decimal
   * rounding is exercised, plus PageRank rows and symbols with only one of the
   * three dimensions.
   */
  async function seed(): Promise<void> {
    await db.upsertFile(
      { relPath: "app/a.rb", language: "ruby" },
      {
        fileEdges: [],
        methodEdges: [
          // exact call A#run -> B#x (confidence defaults to 1)
          { sourceSymbolId: "A#run", targetSymbolId: "B#x", targetRelPath: "app/b.rb", callExpression: "b.x()" },
          // dynamic 3-way fan-out from A#run at 1/3 each -> B#x, C#y, D#z
          {
            sourceSymbolId: "A#run",
            targetSymbolId: "C#y",
            targetRelPath: "app/c.rb",
            callExpression: "o.y()",
            edgeKind: "dynamic",
            confidence: 1 / 3,
          },
          {
            sourceSymbolId: "A#run",
            targetSymbolId: "D#z",
            targetRelPath: "app/d.rb",
            callExpression: "o.z()",
            edgeKind: "dynamic",
            confidence: 1 / 3,
          },
        ],
      },
    );
    await db.upsertFile(
      { relPath: "app/b.rb", language: "ruby" },
      {
        fileEdges: [],
        // B#x calls C#y exactly — gives C#y a second incoming edge and B#x an outgoing one
        methodEdges: [
          { sourceSymbolId: "B#x", targetSymbolId: "C#y", targetRelPath: "app/c.rb", callExpression: "c.y()" },
        ],
      },
    );
    // PageRank for a subset (C#y absent → per-symbol getPageRank returns 0).
    await db.replacePageRanks(
      new Map<string, number>([
        ["A#run", 0.12345],
        ["B#x", 0.00081],
      ]),
    );
  }

  it("matches the per-symbol getters for every symbol (confidence-weighted + rounding + 0-defaults)", async () => {
    await seed();

    // The universe of symbols the deferred-chunk pass would look up, each with
    // the file that declares it, INCLUDING one that appears in no edge/metric
    // table (must read as {0,0,0}).
    const declarations: [SymbolId, string][] = [
      ["A#run", "app/a.rb"],
      ["B#x", "app/b.rb"],
      ["C#y", "app/c.rb"],
      ["D#z", "app/d.rb"],
      ["Missing#nope", "app/missing.rb"],
    ];

    const bulk = await db.getChunkSignalsBulk();

    for (const [id, relPath] of declarations) {
      const expectedFanIn = await db.getCalledByCount(id);
      const expectedFanOut = await db.getCallSiteCount(id);
      const expectedPageRank = await db.getPageRank(id);
      const got = bulk.get(fileScopedSymbolKey({ relPath, symbolId: id }));
      expect({
        fanIn: got?.fanIn ?? 0,
        fanOut: got?.fanOut ?? 0,
        pageRank: got?.pageRank ?? 0,
      }).toEqual({ fanIn: expectedFanIn, fanOut: expectedFanOut, pageRank: expectedPageRank });
    }

    // Concrete spot-check of the confidence-weighted values (2-decimal rounded):
    // C#y incoming = 1/3 (from A#run dynamic) + 1 (from B#x exact) = 1.33.
    expect(bulk.get(fileScopedSymbolKey({ relPath: "app/c.rb", symbolId: "C#y" }))?.fanIn).toBe(1.33);
    // A#run outgoing = 1 + 1/3 + 1/3 = 1.67.
    expect(bulk.get(fileScopedSymbolKey({ relPath: "app/a.rb", symbolId: "A#run" }))?.fanOut).toBe(1.67);
    // PageRank round-trips as a plain number.
    expect(bulk.get(fileScopedSymbolKey({ relPath: "app/a.rb", symbolId: "A#run" }))?.pageRank).toBe(0.12345);
  });

  it("returns an empty map on a freshly migrated graph (no edges, no metrics)", async () => {
    const bulk = await db.getChunkSignalsBulk();
    expect(bulk.size).toBe(0);
  });
});
