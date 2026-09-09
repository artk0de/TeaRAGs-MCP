/**
 * `upsertFilesBulk` — the batched pass-2 edge write that folds M files'
 * per-source-file DELETE+INSERT into ONE BEGIN/COMMIT (and, on the daemon, one
 * IPC round-trip) instead of M `upsertFile` transactions.
 *
 * Equivalence invariant under test: a set of files written via `upsertFilesBulk`
 * persists byte-identical rows — across cg_symbols_files, cg_symbols_edges_file,
 * cg_symbols_edges_method, cg_symbols_inheritance, cg_ambiguous_fanout — to
 * writing the same files one-by-one via `upsertFile`. This pins that the shared
 * `upsertFileRows` body preserves every per-file semantic under batching:
 * per-source-file DELETE last-wins, null-targetSymbolId method-edge skip,
 * INSERT OR IGNORE dedupe (within a file AND across files), inheritance +
 * ambiguous-fanout lifecycle.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DuckDBPreparedStatement } from "@duckdb/node-api";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import { DuckDbGraphSession } from "../../../../src/core/adapters/duckdb/graph-session.js";
import type { BulkFileUpsertEntry } from "../../../../src/core/contracts/types/codegraph.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/domains/maintenance/migration/database/runner.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function freshDb(): Promise<DuckDbGraphClient> {
  const dir = mkdtempSync(join(tmpdir(), "cg-files-bulk-"));
  const db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
  await db.init();
  await runMigrations(db, DATABASE_MIGRATIONS);
  cleanups.push(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return db;
}

/** Deterministic dump of every write-affected table, sorted, for equality. */
async function dumpGraph(db: DuckDbGraphClient): Promise<Record<string, unknown[]>> {
  const q = async (sql: string): Promise<unknown[]> => db.queryAll(sql);
  return {
    files: await q("SELECT rel_path, language FROM cg_symbols_files ORDER BY rel_path"),
    fileEdges: await q(
      "SELECT source_rel_path, target_rel_path, import_text FROM cg_symbols_edges_file ORDER BY source_rel_path, target_rel_path, import_text",
    ),
    methodEdges: await q(
      "SELECT source_symbol_id, source_rel_path, target_symbol_id, target_rel_path, call_expression, edge_kind, confidence FROM cg_symbols_edges_method ORDER BY source_symbol_id, target_symbol_id, call_expression",
    ),
    inheritance: await q(
      "SELECT source_fq_name, source_rel_path, ancestor_fq_name, kind, ordinal FROM cg_symbols_inheritance ORDER BY source_fq_name, ancestor_fq_name, kind",
    ),
    fanout: await q(
      "SELECT source_symbol_id, source_rel_path, call_expression, member, candidate_count FROM cg_ambiguous_fanout ORDER BY source_symbol_id, call_expression",
    ),
  };
}

/**
 * A representative batch exercising every write path + edge case: file edges,
 * exact + dynamic (fractional confidence) method edges, a null-target method
 * edge (must be SKIPPED), an intra-file duplicate call (OR IGNORE dedupe),
 * inheritance rows, and ambiguous-fanout aggregates.
 */
function batch(): BulkFileUpsertEntry[] {
  return [
    {
      node: { relPath: "app/a.rb", language: "ruby" },
      edges: {
        fileEdges: [{ targetRelPath: "app/b.rb", importText: "zeitwerk:B" }],
        methodEdges: [
          { sourceSymbolId: "A#run", targetSymbolId: "B#x", targetRelPath: "app/b.rb", callExpression: "b.x()" },
          // duplicate call shape in the same file — OR IGNORE keeps one row
          { sourceSymbolId: "A#run", targetSymbolId: "B#x", targetRelPath: "app/b.rb", callExpression: "b.x()" },
          {
            sourceSymbolId: "A#run",
            targetSymbolId: "C#y",
            targetRelPath: "app/c.rb",
            callExpression: "o.y()",
            edgeKind: "dynamic",
            confidence: 0.25,
          },
          // null target — must be skipped at the boundary (PK NOT NULL)
          { sourceSymbolId: "A#run", targetSymbolId: null, targetRelPath: "app/z.rb", callExpression: "mystery()" },
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
        ],
        ambiguousFanouts: [{ sourceSymbolId: "A#run", callExpression: "x.firm", member: "firm", candidateCount: 240 }],
      },
    },
    {
      node: { relPath: "app/b.rb", language: "ruby" },
      edges: {
        fileEdges: [],
        methodEdges: [
          { sourceSymbolId: "B#x", targetSymbolId: "C#y", targetRelPath: "app/c.rb", callExpression: "c.y()" },
        ],
      },
    },
  ];
}

describe("DuckDbGraphClient — upsertFilesBulk equivalence to per-file upsertFile", () => {
  it("persists identical rows across all tables as the per-file path", async () => {
    const bulkDb = await freshDb();
    const perFileDb = await freshDb();

    await bulkDb.upsertFilesBulk(batch());
    for (const { node, edges } of batch()) await perFileDb.upsertFile(node, edges);

    expect(await dumpGraph(bulkDb)).toEqual(await dumpGraph(perFileDb));
  });

  it("preserves per-source-file DELETE last-wins on re-upsert within a batch", async () => {
    const bulkDb = await freshDb();
    const perFileDb = await freshDb();

    // Same file appears twice in the batch (a re-walk) — the SECOND entry's
    // per-source-file DELETE must win, exactly as two sequential upsertFile calls.
    const reBatch: BulkFileUpsertEntry[] = [
      {
        node: { relPath: "app/a.rb", language: "ruby" },
        edges: {
          fileEdges: [],
          methodEdges: [
            { sourceSymbolId: "A#m", targetSymbolId: "B#old", targetRelPath: "app/b.rb", callExpression: "old()" },
          ],
        },
      },
      {
        node: { relPath: "app/a.rb", language: "ruby" },
        edges: {
          fileEdges: [],
          methodEdges: [
            { sourceSymbolId: "A#m", targetSymbolId: "B#new", targetRelPath: "app/b.rb", callExpression: "fresh()" },
          ],
        },
      },
    ];
    await bulkDb.upsertFilesBulk(reBatch);
    for (const { node, edges } of reBatch) await perFileDb.upsertFile(node, edges);

    const dump = await dumpGraph(bulkDb);
    expect(dump).toEqual(await dumpGraph(perFileDb));
    // Only the second (fresh) edge survives.
    expect(dump.methodEdges).toHaveLength(1);
    expect((dump.methodEdges[0] as { target_symbol_id: string }).target_symbol_id).toBe("B#new");
  });

  it("empty batch is a no-op", async () => {
    const db = await freshDb();
    await db.upsertFilesBulk([]);
    expect((await dumpGraph(db)).files).toHaveLength(0);
  });

  it("rolls the whole batch back (no partial rows) when a bad row fails", async () => {
    // The batch folds M files into ONE BEGIN/COMMIT, and DELETEs/INSERTs are
    // now themselves batched across the whole set rather than issued in a
    // per-file loop — so there is no longer an "Nth file's write" call to
    // intercept. Trigger a genuine DuckDB failure instead (a NOT NULL PK
    // violation on cg_symbols_edges_method's source_symbol_id, mirroring
    // upsertSymbolsBulk's "bad row" rollback test) and assert the same
    // all-or-nothing invariant: nothing from the batch — good rows included —
    // survives a failed COMMIT.
    const db = await freshDb();
    const bad: BulkFileUpsertEntry[] = [
      ...batch(),
      {
        node: { relPath: "app/bad.rb", language: "ruby" },
        edges: {
          fileEdges: [],
          methodEdges: [
            {
              // @ts-expect-error sourceSymbolId is required — this is the invalid row.
              sourceSymbolId: null,
              targetSymbolId: "X#y",
              targetRelPath: "app/x.rb",
              callExpression: "y()",
            },
          ],
        },
      },
    ];

    await expect(db.upsertFilesBulk(bad)).rejects.toBeTruthy();
    // Nothing landed — not even the earlier, otherwise-valid files.
    expect((await dumpGraph(db)).files).toHaveLength(0);
  });

  it("collapses per-file DELETEs into a handful of batched IN-list statements per group", async () => {
    // bd tea-rags-mcp-wgt19 follow-up: the pre-batching path issued one
    // DELETE per file per table (4 tables x N files), each paying its own
    // scan/FSST-decompress cost on cg_symbols_edges_file/cg_symbols_edges_method's
    // compressed VARCHAR columns. Writes are now batched per interleave GROUP
    // (BULK_INTERLEAVE_GROUP_FILES=32 in file-graph-store.ts) rather than
    // across the whole incoming set — see that constant's doc for why a
    // whole-set batch crashed DuckDB on real data. 250 files spans 8 groups
    // (ceil(250/32)), so this also exercises the chunk boundary. Mirrors the
    // prepared-statement-count assertion style already used for per-file edge
    // batching in client-batched-edge-writes.test.ts.
    const db = await freshDb();
    const N = 250;
    const entries: BulkFileUpsertEntry[] = Array.from({ length: N }, (_, i) => ({
      node: { relPath: `app/f${i}.rb`, language: "ruby" },
      edges: {
        fileEdges: [{ targetRelPath: "app/shared.rb", importText: "./shared" }],
        methodEdges: [
          {
            sourceSymbolId: `F${i}#m`,
            targetSymbolId: "Shared#x",
            targetRelPath: "app/shared.rb",
            callExpression: "x()",
          },
        ],
      },
    }));

    const destroySpy = vi.spyOn(DuckDBPreparedStatement.prototype, "destroySync");
    await db.upsertFilesBulk(entries);
    // The invariant is that statement count scales with GROUPS, not with files.
    // Old per-file loop: >= 250 files x 5 statements (upsert + 4 deletes) = 1250+.
    // Grouped batching: 8 groups x a handful of scope reads / deletes / inserts.
    // The bound moved 70 → 80 when `cg_pass1_aggregates` became the sixth
    // reconciled table (bd tea-rags-mcp-znxg8) — a constant per group, which is
    // exactly what this test exists to distinguish from a constant per file.
    expect(destroySpy.mock.calls.length).toBeLessThanOrEqual(80);
    destroySpy.mockRestore();

    const filesCount = await db.queryAll<{ n: number | bigint }>("SELECT COUNT(*) AS n FROM cg_symbols_files");
    expect(Number(filesCount[0].n)).toBe(N);
    const edgesCount = await db.queryAll<{ n: number | bigint }>("SELECT COUNT(*) AS n FROM cg_symbols_edges_method");
    expect(Number(edgesCount[0].n)).toBe(N);
  });

  it("never DELETEs a row the same write is re-INSERTing", async () => {
    // bd tea-rags-mcp-wgt19 follow-up, then bd tea-rags-mcp-8l8d3. Live
    // CODEGRAPH_FORCE_RESOLVE runs against taxdome killed the daemon with a
    // native DuckDB FatalException — "Failed to append to
    // PRIMARY_cg_symbols_edges_file_2: ... duplicate key" — from index
    // maintenance at commit. The trigger is a transaction whose DELETE set and
    // INSERT set share a primary key: DuckDB's `UndoBuffer::RevertCommit`
    // restores the deleted rows into the indexes when a commit fails for any
    // reason, and the re-append collides with the key the same transaction
    // inserted (duckdb/duckdb#16520, duckdb/duckdb#15092). It surfaces as
    // `libc++abi: terminating`, which no JavaScript handler can catch.
    //
    // The first fix bounded how MANY such keys were pending at once; the crash
    // came back. This asserts the invariant instead: across a whole bulk write,
    // the set of rows deleted and the set of rows inserted are disjoint.
    //
    // N=250 spans two 200-row statement chunks per table, so a writer that
    // reverted to a blind whole-scope DELETE fails here rather than at some
    // size-dependent boundary.
    const db = await freshDb();
    const N = 250;
    const entries: BulkFileUpsertEntry[] = Array.from({ length: N }, (_, i) => ({
      node: { relPath: `app/g${i}.rb`, language: "ruby" },
      edges: { fileEdges: [{ targetRelPath: "app/shared.rb", importText: "./shared" }], methodEdges: [] },
    }));
    // Seed, so the re-write below has something it COULD have deleted.
    await db.upsertFilesBulk(entries);

    const deleted: string[] = [];
    const inserted: string[] = [];
    const original = DuckDbGraphSession.prototype.run;
    const spy = vi.spyOn(DuckDbGraphSession.prototype, "run").mockImplementation(async function (
      this: DuckDbGraphSession,
      sql: string,
      params?: unknown[],
    ) {
      const verb = sql.trim().split(/\s+/)[0];
      // Every value the statement touched, as an order-independent bag. A key
      // that shows up on both sides means the crashing overlap is back —
      // whatever statement shape produced it.
      if (verb === "DELETE") deleted.push(...(params ?? []).map(String));
      if (verb === "INSERT") inserted.push(...(params ?? []).map(String));
      return original.call(this, sql, params);
    });

    // Same edges, one file gains a target: only that one row may be written,
    // and nothing at all may be deleted.
    const rewritten = entries.map((e, i) =>
      i === 7
        ? {
            ...e,
            edges: {
              fileEdges: [
                { targetRelPath: "app/shared.rb", importText: "./shared" },
                { targetRelPath: "app/extra.rb", importText: "./extra" },
              ],
              methodEdges: [],
            },
          }
        : e,
    );
    await db.upsertFilesBulk(rewritten);
    spy.mockRestore();

    expect(inserted).toContain("app/extra.rb");
    expect(new Set(deleted.filter((v) => inserted.includes(v)))).toEqual(new Set());
    expect(deleted).toEqual([]);
  });

  it("keeps both rows when two files in the SAME bulk batch emit the same method-edge tuple", async () => {
    // Monkey-patch / namesake case (same invariant as
    // client-batched-edge-writes.test.ts's per-file version, now exercised
    // across one bulk call instead of two sequential upsertFile calls): A#x is
    // "defined" in both app/one.rb and app/two.rb, both emitting the same
    // (source_symbol_id, call_expression, target_symbol_id) tuple.
    //
    // INVARIANT CHANGED by bd tea-rags-mcp-ex28m — this used to assert
    // first-wins by batch order, which silently dropped app/two.rb's edge.
    // source_rel_path is in the primary key now, so flattening every file's
    // edges into one INSERT OR IGNORE must carry BOTH files' rows through.
    const db = await freshDb();
    const edge = {
      sourceSymbolId: "A#x",
      targetSymbolId: "B#y" as string | null,
      targetRelPath: "app/b.rb",
      callExpression: "y()",
    };
    await db.upsertFilesBulk([
      { node: { relPath: "app/one.rb", language: "ruby" }, edges: { fileEdges: [], methodEdges: [edge] } },
      { node: { relPath: "app/two.rb", language: "ruby" }, edges: { fileEdges: [], methodEdges: [{ ...edge }] } },
    ]);

    const rows = await db.queryAll<{ source_rel_path: string }>(
      "SELECT source_rel_path FROM cg_symbols_edges_method WHERE source_symbol_id = 'A#x' ORDER BY source_rel_path",
    );
    expect(rows.map((r) => r.source_rel_path)).toEqual(["app/one.rb", "app/two.rb"]);
  });
});
