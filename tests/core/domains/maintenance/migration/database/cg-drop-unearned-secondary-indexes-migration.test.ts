import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import { DATABASE_MIGRATIONS } from "../../../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../../../src/core/domains/maintenance/migration/database/runner.js";

const MIGRATION = "019-cg-drop-unearned-secondary-indexes.sql";

/**
 * bd tea-rags-mcp-oucyv, second pass — 018 fixed `cg_symbols_cycles`; the same
 * defect was still live on `cg_symbols`.
 *
 * DuckDB answers `WHERE <col> = ?` from a single-column ART index whenever one
 * exists (`EXPLAIN ANALYZE` reports `Type: Index Scan`), and an ART that has
 * drifted from its table — which a killed process, an invalidated database or an
 * aborted run leaves behind — makes that predicate wrong. Both halves were
 * observed on this project's own index:
 *
 *   - `DELETE FROM cg_symbols WHERE rel_path = ?` matched nothing while the rows
 *     were plainly there, so `INSERT OR IGNORE` then skipped every row it was
 *     supposed to replace and the file's symbols silently never updated;
 *   - once the filter column's index was healthy but a SIBLING index was not,
 *     index maintenance failed with `Failed to delete all rows from index` and
 *     DuckDB invalidated the whole database.
 *
 * The composite PRIMARY KEY is never used for pushdown — not even for a
 * full-key lookup — so it cannot produce either failure, and it stays. What goes
 * is the single-column secondary indexes that do not earn the exposure.
 *
 * Measured on a taxdome-class table (504k rows) before choosing: 256 scoped
 * DELETEs ran 264ms WITHOUT the indexes versus 301ms with them — ART maintenance
 * costs more than the scan it saves — and `findSymbolChunk`, the one read that
 * filtered by an indexed column, went from 0.19ms to 1.34ms on a lookup issued
 * once per request.
 *
 * Deliberately NOT dropped, because they answer real filters and were measured
 * to earn it: the `cg_symbols_edges_method` / `cg_symbols_edges_file` /
 * `cg_symbols_inheritance` (fq-name) / `cg_ambiguous_fanout` (member) indexes.
 */
describe("019 drops the codegraph secondary indexes that do not earn their drift exposure", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-unearned-idx-mig-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function indexesOn(table: string): Promise<string[]> {
    const rows = await db.queryAll<{ index_name: string }>(
      "SELECT index_name FROM duckdb_indexes() WHERE table_name = ? ORDER BY index_name",
      [table],
    );
    return rows.map((r) => r.index_name);
  }

  async function planOf(sql: string): Promise<string> {
    const rows = await db.queryAll<{ explain_value: string }>(`EXPLAIN ANALYZE ${sql}`);
    return rows[0]?.explain_value ?? "";
  }

  it("leaves cg_symbols and cg_symbols_metrics carrying no secondary index at all", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);

    // Both tables take a DELETE and are rewritten wholesale, so every ART on
    // them is a liability with no counterpart benefit.
    expect(await indexesOn("cg_symbols")).toEqual([]);
    expect(await indexesOn("cg_symbols_metrics")).toEqual([]);
  });

  it("drops the inheritance ancestor_symbol_id index, which nothing ever filters by", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);

    // `ancestor_symbol_id` is only ever SELECTed as a projection; the fq-name
    // indexes beside it answer real `WHERE` clauses and stay.
    const inheritance = await indexesOn("cg_symbols_inheritance");
    expect(inheritance).not.toContain("idx_cg_inh_ancestor_sym");
    expect(inheritance).toEqual(
      expect.arrayContaining(["idx_cg_inh_source", "idx_cg_inh_ancestor_fq", "idx_cg_inh_source_path"]),
    );
  });

  it("keeps the indexes that answer real filters on the edge and fan-out tables", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);

    expect(await indexesOn("cg_symbols_edges_method")).toEqual(
      expect.arrayContaining([
        "idx_cg_symbols_edges_method_target_symbol",
        "idx_cg_symbols_edges_method_target_rel_path",
        "idx_cg_symbols_edges_method_source_rel_path",
      ]),
    );
    expect(await indexesOn("cg_symbols_edges_file")).toContain("idx_cg_symbols_edges_file_target");
    expect(await indexesOn("cg_ambiguous_fanout")).toEqual(
      expect.arrayContaining(["idx_cg_ambiguous_fanout_member", "idx_cg_ambiguous_fanout_source_rel_path"]),
    );
  });

  it("keeps every cg_symbols predicate off an index scan, so a drifted ART cannot answer one", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);
    await db.upsertSymbolsBulk([
      {
        relPath: "src/a.ts",
        definitions: [
          { symbolId: "A#one", fqName: "Mod.A#one", shortName: "one", relPath: "src/a.ts", kind: "method" },
          { symbolId: "A#two", fqName: "Mod.A#two", shortName: "two", relPath: "src/a.ts", kind: "method" },
        ],
      },
    ] as never);

    // The write path's own predicate, and the one read that used to be indexed.
    expect(await planOf("SELECT count(*) FROM cg_symbols WHERE rel_path = 'src/a.ts'")).not.toContain("Index Scan");
    expect(await planOf("SELECT count(*) FROM cg_symbols WHERE symbol_id = 'A#one'")).not.toContain("Index Scan");
    expect(await planOf("SELECT count(*) FROM cg_symbols WHERE fq_name = 'Mod.A#one'")).not.toContain("Index Scan");
  });

  it("drops what an already-provisioned database is carrying, without losing its rows", async () => {
    // Every migration up to 018 applied — what an existing install looks like.
    const legacy = DATABASE_MIGRATIONS.filter((m) => m.filename !== MIGRATION);
    await runMigrations(db, legacy);
    expect(await indexesOn("cg_symbols")).toEqual(
      expect.arrayContaining([
        "idx_cg_symbols_fq",
        "idx_cg_symbols_short",
        "idx_cg_symbols_rel_path",
        "idx_cg_symbols_symbol",
      ]),
    );
    await db.upsertSymbolsBulk([
      {
        relPath: "src/b.ts",
        definitions: [
          { symbolId: "B#one", fqName: "Mod.B#one", shortName: "one", relPath: "src/b.ts", kind: "method" },
        ],
      },
    ] as never);

    const result = await runMigrations(db, DATABASE_MIGRATIONS);

    expect(result.applied).toContain(MIGRATION);
    expect(await indexesOn("cg_symbols")).toEqual([]);
    expect(await db.listAllSymbols()).toHaveLength(1);
  });

  it("is idempotent", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);
    const second = await runMigrations(db, DATABASE_MIGRATIONS);

    expect(second.applied).not.toContain(MIGRATION);
    expect(second.skipped).toContain(MIGRATION);
  });

  it("still replaces a file's symbols wholesale once the indexes are gone", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);
    const upsert = async (relPath: string, ids: string[]): Promise<void> =>
      db.upsertSymbolsBulk([
        {
          relPath,
          definitions: ids.map((symbolId) => ({
            symbolId,
            fqName: `Mod.${symbolId}`,
            shortName: symbolId,
            relPath,
            kind: "method",
          })),
        },
      ] as never);

    await upsert("src/a.ts", ["A#one", "A#two"]);
    await upsert("src/b.ts", ["B#one"]);
    // Re-walk of a.ts drops one symbol and adds another — the scoped DELETE has
    // to actually remove the old set, which is what silently stopped happening.
    await upsert("src/a.ts", ["A#one", "A#three"]);

    const ids = (await db.listAllSymbols()).map((d) => d.symbolId).sort();
    expect(ids).toEqual(["A#one", "A#three", "B#one"]);
  });
});
