import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import { DATABASE_MIGRATIONS } from "../../../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../../../src/core/domains/maintenance/migration/database/runner.js";

const MIGRATION = "018-cg-cycles-drop-secondary-indexes.sql";

/**
 * bd tea-rags-mcp-oucyv — `--force-enrichments codegraph` aborted the whole
 * index run with
 * `Duplicate key "cycle_id: 0, scope: method, member: insertable" violates
 * primary key constraint`.
 *
 * `cg_symbols_cycles` is rewritten one scope at a time: `replaceCycles` issues
 * `DELETE ... WHERE scope = ?` and then re-inserts the freshly computed
 * components. 003 put non-unique ART indexes on `scope` and `member`, and
 * DuckDB's filter pushdown answers that `WHERE scope = ?` from the ART rather
 * than from the table. An ART that has drifted from its table — which is what
 * the reporting database was found in — reports zero matches, so the DELETE
 * removes nothing and the re-INSERT collides with rows the PRIMARY KEY still
 * holds. `findCycles` reads through the same predicate, so the same drift also
 * makes `find_cycles` silently answer "no cycles".
 *
 * Neither index earns that risk: nothing queries this table by `member` at all,
 * and `scope` has two distinct values over a table whose size is the total
 * cycle membership of the repository (27 rows on this project's own index). The
 * PRIMARY KEY, which is what actually enforces correctness, stays.
 */
describe("018 cg_symbols_cycles drops its secondary indexes", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-cycles-idx-mig-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function indexNames(): Promise<string[]> {
    const rows = await db.queryAll<{ index_name: string }>(
      "SELECT index_name FROM duckdb_indexes() WHERE table_name = 'cg_symbols_cycles'",
    );
    return rows.map((r) => r.index_name);
  }

  it("leaves no secondary index behind on a freshly migrated database, and is idempotent", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);
    const second = await runMigrations(db, DATABASE_MIGRATIONS);

    expect(second.applied).not.toContain(MIGRATION);
    expect(second.skipped).toContain(MIGRATION);
    expect(await indexNames()).toEqual([]);
  });

  it("drops the indexes an already-provisioned database is carrying, without touching its rows", async () => {
    // Exactly what an existing install looks like: every migration up to 017
    // applied, so 003's two indexes are present and populated.
    const legacy = DATABASE_MIGRATIONS.filter((m) => m.filename !== MIGRATION);
    await runMigrations(db, legacy);
    expect(await indexNames()).toEqual(
      expect.arrayContaining(["idx_cg_symbols_cycles_scope", "idx_cg_symbols_cycles_member"]),
    );
    await db.replaceCycles("method", [["insertable", "linearize"]]);

    const result = await runMigrations(db, DATABASE_MIGRATIONS);

    expect(result.applied).toContain(MIGRATION);
    expect(await indexNames()).toEqual([]);
    expect(await db.findCycles("method")).toEqual([
      { cycleId: 0, scope: "method", members: ["insertable", "linearize"] },
    ]);
  });

  it("keeps the scoped read off any index scan, so a drifted ART cannot void it", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);
    await db.replaceCycles("method", [["insertable", "linearize"]]);

    const plan = await db.queryAll<{ explain_value: string }>(
      "EXPLAIN ANALYZE SELECT cycle_id, member, position FROM cg_symbols_cycles WHERE scope = 'method'",
    );

    expect(plan[0]?.explain_value).not.toContain("Index Scan");
  });

  it("still replaces one scope at a time, leaving the other scope's cycles alone", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);
    await db.replaceCycles("file", [["a.ts", "b.ts"]]);
    await db.replaceCycles("method", [["insertable", "linearize"]]);

    // The crashing production sequence: recompute both scopes a second time
    // with byte-identical membership. Every re-inserted key already exists, so
    // the run only survives if the scoped DELETE actually removed them.
    await db.replaceCycles("file", [["a.ts", "b.ts"]]);
    await db.replaceCycles("method", [["insertable", "linearize"]]);

    expect(await db.findCycles("file")).toEqual([{ cycleId: 0, scope: "file", members: ["a.ts", "b.ts"] }]);
    expect(await db.findCycles("method")).toEqual([
      { cycleId: 0, scope: "method", members: ["insertable", "linearize"] },
    ]);
  });
});
