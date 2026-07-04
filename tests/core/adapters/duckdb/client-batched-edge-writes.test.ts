import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DuckDBPreparedStatement } from "@duckdb/node-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/infra/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/infra/migration/database/runner.js";

// bd tea-rags-mcp-f2jsb Task 5 — taxdome wrote 1.58M method edges through
// per-row `INSERT OR IGNORE` prepared statements (effective ~97 rows/sec,
// hours of WAL writes). `upsertFileImpl` batches edge writes into chunked
// multi-row `INSERT OR IGNORE ... VALUES (?,...),(?,...)` statements inside
// the SAME per-file transaction. These tests pin:
//   (a) exact behaviour identity with the old per-row path (defaults,
//       null-target skip, in-batch dedupe, cross-file dedupe),
//   (b) the batching mechanism itself (prepared-statement count),
//   (c) chunk-boundary completeness (batch > one statement),
//   (d) a generous perf smoke as a ~100 rows/sec regression canary.
describe("DuckDbGraphClient — batched edge writes in upsertFile (f2jsb)", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-batched-edges-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
    await runMigrations(db, DATABASE_MIGRATIONS);
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("lands the same rows as the per-row path for a mixed batch (defaults, null-target skip, in-batch dedupe)", async () => {
    await db.upsertFile(
      { relPath: "app/a.rb", language: "ruby" },
      {
        fileEdges: [
          { targetRelPath: "app/b.rb", importText: "./b" },
          { targetRelPath: "app/c.rb", importText: "./c" },
          // Same (source, target) re-imported on another line — PK collision
          // INSIDE one batch; first occurrence wins, exactly like the old
          // sequential per-row inserts.
          { targetRelPath: "app/b.rb", importText: "./b-again" },
        ],
        methodEdges: [
          // Omitted edgeKind/confidence must persist as exact/1.0.
          { sourceSymbolId: "A#x", targetSymbolId: "B#y", targetRelPath: "app/b.rb", callExpression: "y()" },
          // Null target — resolver couldn't pin the call; must be skipped
          // BEFORE batching (the PK includes target_symbol_id, NOT NULL).
          { sourceSymbolId: "A#x", targetSymbolId: null, targetRelPath: "app/b.rb", callExpression: "gone()" },
          {
            sourceSymbolId: "A#x",
            targetSymbolId: "C#w",
            targetRelPath: "app/c.rb",
            callExpression: "w()",
            edgeKind: "dynamic",
            confidence: 0.5,
          },
          // Duplicate (source, call, target) PK tuple WITHIN the batch — the
          // FIRST occurrence's provenance (exact/1.0) must win, matching the
          // old per-row INSERT OR IGNORE sequence.
          {
            sourceSymbolId: "A#x",
            targetSymbolId: "B#y",
            targetRelPath: "app/b.rb",
            callExpression: "y()",
            edgeKind: "dynamic",
            confidence: 0.25,
          },
        ],
        inheritance: [
          {
            sourceFqName: "A",
            sourceSymbolId: "A",
            ancestorFqName: "Base",
            ancestorSymbolId: "Base",
            kind: "super",
            ordinal: 0,
          },
          // Duplicate (source_fq, source_rel_path, ancestor_fq, kind) PK —
          // first ordinal wins.
          {
            sourceFqName: "A",
            sourceSymbolId: "A",
            ancestorFqName: "Base",
            ancestorSymbolId: "Base",
            kind: "super",
            ordinal: 7,
          },
        ],
        ambiguousFanouts: [
          { sourceSymbolId: "A#x", callExpression: "firm.save", member: "save", candidateCount: 240 },
          // Duplicate (source, call_expression) aggregate — first count wins.
          { sourceSymbolId: "A#x", callExpression: "firm.save", member: "save", candidateCount: 999 },
        ],
      },
    );

    const fileRows = await db.queryAll<{ target_rel_path: string; import_text: string | null }>(
      "SELECT target_rel_path, import_text FROM cg_symbols_edges_file WHERE source_rel_path = 'app/a.rb' ORDER BY target_rel_path",
    );
    expect(fileRows).toEqual([
      { target_rel_path: "app/b.rb", import_text: "./b" },
      { target_rel_path: "app/c.rb", import_text: "./c" },
    ]);

    const methodRows = await db.queryAll<{
      target_symbol_id: string;
      edge_kind: string;
      confidence: number | string;
    }>(
      "SELECT target_symbol_id, edge_kind, confidence FROM cg_symbols_edges_method WHERE source_rel_path = 'app/a.rb' ORDER BY target_symbol_id",
    );
    expect(methodRows.map((r) => ({ ...r, confidence: Number(r.confidence) }))).toEqual([
      { target_symbol_id: "B#y", edge_kind: "exact", confidence: 1 },
      { target_symbol_id: "C#w", edge_kind: "dynamic", confidence: 0.5 },
    ]);

    const inhRows = await db.queryAll<{ ordinal: number | bigint }>(
      "SELECT ordinal FROM cg_symbols_inheritance WHERE source_rel_path = 'app/a.rb'",
    );
    expect(inhRows).toHaveLength(1);
    expect(Number(inhRows[0].ordinal)).toBe(0);

    const fanRows = await db.queryAll<{ candidate_count: number | bigint }>(
      "SELECT candidate_count FROM cg_ambiguous_fanout WHERE source_rel_path = 'app/a.rb'",
    );
    expect(fanRows).toHaveLength(1);
    expect(Number(fanRows[0].candidate_count)).toBe(240);
  });

  it("keeps the first-persisted row when another file already wrote the same (source, call, target) tuple", async () => {
    // Monkey-patch case: `A#x` is defined in BOTH app/one.rb and app/two.rb;
    // walking each file emits the same (source_symbol_id, call_expression,
    // target_symbol_id) PK tuple with a different source_rel_path. In-JS
    // dedupe inside ONE file's batch cannot see the other file's persisted
    // rows — INSERT OR IGNORE is what absorbs the cross-file PK collision,
    // so it must survive the batching rewrite.
    const edge = {
      sourceSymbolId: "A#x",
      targetSymbolId: "B#y" as string | null,
      targetRelPath: "app/b.rb",
      callExpression: "y()",
    };
    await db.upsertFile({ relPath: "app/one.rb", language: "ruby" }, { fileEdges: [], methodEdges: [edge] });
    await db.upsertFile({ relPath: "app/two.rb", language: "ruby" }, { fileEdges: [], methodEdges: [{ ...edge }] });

    const rows = await db.queryAll<{ source_rel_path: string }>(
      "SELECT source_rel_path FROM cg_symbols_edges_method WHERE source_symbol_id = 'A#x'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].source_rel_path).toBe("app/one.rb");
  });

  it("lands a file with more edges than one statement chunk completely (crosses the batch boundary)", async () => {
    const N = 205; // EDGE_INSERT_CHUNK_ROWS (200) + a few — spans two statements
    const methodEdges = Array.from({ length: N }, (_, i) => ({
      sourceSymbolId: `A#m${i}`,
      targetSymbolId: `B#t${i}`,
      targetRelPath: "app/b.rb",
      callExpression: `t${i}()`,
    }));
    await db.upsertFile({ relPath: "app/a.rb", language: "ruby" }, { fileEdges: [], methodEdges });

    const count = await db.queryAll<{ n: number | bigint }>(
      "SELECT COUNT(*) AS n FROM cg_symbols_edges_method WHERE source_rel_path = 'app/a.rb'",
    );
    expect(Number(count[0].n)).toBe(N);
    // No dropped tail: first row of statement 1 AND last row of statement 2.
    const probe = await db.queryAll<{ target_symbol_id: string }>(
      "SELECT target_symbol_id FROM cg_symbols_edges_method WHERE target_symbol_id IN ('B#t0', 'B#t204')",
    );
    expect(probe.map((r) => r.target_symbol_id).sort()).toEqual(["B#t0", "B#t204"]);

    // Re-walk lifecycle intact: re-upserting the file replaces its rows via
    // the per-file DELETE (the path migration 014 indexes).
    await db.upsertFile(
      { relPath: "app/a.rb", language: "ruby" },
      { fileEdges: [], methodEdges: methodEdges.slice(0, 3) },
    );
    const after = await db.queryAll<{ n: number | bigint }>(
      "SELECT COUNT(*) AS n FROM cg_symbols_edges_method WHERE source_rel_path = 'app/a.rb'",
    );
    expect(Number(after[0].n)).toBe(3);
  });

  it("issues chunked multi-row statements, not one prepared statement per edge", async () => {
    // The taxdome root cause was a prepare/bind/destroy round-trip per EDGE.
    // Every `run()` disposes exactly ONE prepared statement (native-leak
    // guard), so destroySync count == prepared-statement count. 500 method
    // edges through the per-row path prepare 500+ statements; the batched
    // path needs ceil(500/200) = 3 edge inserts plus the fixed per-file
    // statements (file-row upsert + 4 per-file DELETEs).
    const methodEdges = Array.from({ length: 500 }, (_, i) => ({
      sourceSymbolId: `A#m${i}`,
      targetSymbolId: `B#t${i}`,
      targetRelPath: "app/b.rb",
      callExpression: `t${i}()`,
    }));
    const destroySpy = vi.spyOn(DuckDBPreparedStatement.prototype, "destroySync");
    await db.upsertFile({ relPath: "app/a.rb", language: "ruby" }, { fileEdges: [], methodEdges });
    expect(destroySpy.mock.calls.length).toBeLessThanOrEqual(20);
    destroySpy.mockRestore();
  });

  it("inserts 10_000 method edges through upsertFile in bounded time (perf smoke)", async () => {
    const N = 10_000;
    const methodEdges = Array.from({ length: N }, (_, i) => ({
      sourceSymbolId: `S#m${i}`,
      targetSymbolId: `T#t${i}`,
      targetRelPath: "app/t.rb",
      callExpression: `t${i}()`,
    }));
    const t0 = performance.now();
    await db.upsertFile({ relPath: "app/s.rb", language: "ruby" }, { fileEdges: [], methodEdges });
    const elapsedMs = performance.now() - t0;

    const rows = await db.queryAll<{ n: number | bigint }>("SELECT COUNT(*) AS n FROM cg_symbols_edges_method");
    expect(Number(rows[0].n)).toBe(N);
    // Generous bound to avoid CI flakes: the point is catching a return to
    // ~100 rows/sec (10k edges would take ~100s), not micro-benchmarking.
    // Batched path lands this well under a second locally; the old per-row
    // path took ~7s.
    expect(
      elapsedMs,
      `10k method edges took ${Math.round(elapsedMs)}ms (~${Math.round(N / (elapsedMs / 1000))} rows/sec)`,
    ).toBeLessThan(15_000);
  }, 30_000);
});
