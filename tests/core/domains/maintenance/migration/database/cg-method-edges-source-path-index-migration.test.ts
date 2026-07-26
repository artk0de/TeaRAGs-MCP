import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import { DATABASE_MIGRATIONS } from "../../../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../../../src/core/domains/maintenance/migration/database/runner.js";

// bd tea-rags-mcp-f2jsb — upsertFileImpl deletes a file's method edges by
// source_rel_path on every re-walk; without an index each DELETE scans the
// whole edge table (24k files x 1.5M rows on taxdome-class corpora = hours of
// WAL writes). 001 already indexes target_symbol_id / target_rel_path; 014
// adds the missing source_rel_path index.
describe("014 cg_symbols_edges_method source_rel_path index migration", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-src-path-idx-mig-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates the source_rel_path index on cg_symbols_edges_method and is idempotent", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);
    const second = await runMigrations(db, DATABASE_MIGRATIONS);
    expect(second.applied).not.toContain("014-cg-method-edges-source-path-index.sql");
    expect(second.skipped).toContain("014-cg-method-edges-source-path-index.sql");

    const indexes = await db.queryAll<{ index_name: string }>(
      "SELECT index_name FROM duckdb_indexes() WHERE table_name = 'cg_symbols_edges_method'",
    );
    expect(indexes.map((i) => i.index_name)).toContain("idx_cg_symbols_edges_method_source_rel_path");
  });
});
