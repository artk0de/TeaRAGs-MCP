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

import { afterEach, describe, expect, it, vi } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import type { BulkFileUpsertEntry } from "../../../../src/core/contracts/types/codegraph.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/infra/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/infra/migration/database/runner.js";

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
  const q = (sql: string): Promise<unknown[]> => db.queryAll(sql);
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

  it("rolls the whole batch back (no partial rows) when a mid-batch file write throws", async () => {
    const db = await freshDb();
    // The batch folds M files into ONE BEGIN/COMMIT. Let the first file's rows
    // land for real, then make the SECOND file's write throw mid-transaction:
    // the catch must ROLLBACK — reverting the first file too — and rethrow, so
    // no partial state survives a failed bulk.
    const proto = db as unknown as { upsertFileRows(node: unknown, edges: unknown): Promise<void> };
    const realRows = proto.upsertFileRows.bind(db);
    let seen = 0;
    vi.spyOn(proto, "upsertFileRows").mockImplementation(async (node, edges) => {
      seen += 1;
      if (seen === 2) throw new Error("bulk write boom");
      return realRows(node, edges);
    });

    await expect(db.upsertFilesBulk(batch())).rejects.toThrow("bulk write boom");
    vi.restoreAllMocks();
    // The first file's write was rolled back with the failed transaction.
    expect((await dumpGraph(db)).files).toHaveLength(0);
  });
});
