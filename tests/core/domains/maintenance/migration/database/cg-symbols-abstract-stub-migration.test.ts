import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import { DATABASE_MIGRATIONS } from "../../../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../../../src/core/domains/maintenance/migration/database/runner.js";

// bd tea-rags-mcp-eikry — the walker's abstract-stub mark (bcdfe) must survive a
// round trip through cg_symbols, otherwise an incremental run that hydrates an
// unchanged file reads its stubs as concrete definitions.
describe("016 cg_symbols is_abstract_stub migration", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-stub-mig-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("adds is_abstract_stub to cg_symbols and is idempotent", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);
    const second = await runMigrations(db, DATABASE_MIGRATIONS);
    expect(second.applied).not.toContain("016-cg-symbols-abstract-stub.sql");
    expect(second.skipped).toContain("016-cg-symbols-abstract-stub.sql");

    const cols = await db.queryAll<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'cg_symbols'",
    );
    expect(cols.map((c) => c.column_name)).toContain("is_abstract_stub");
  });

  it("backfills a pre-016 row shape to the non-stub default", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);
    // An INSERT that omits the column — the exact shape a row written before 016
    // has. It must read back as "not a stub", never as an unmarked concrete def
    // that the probe would trust.
    await db.run(
      "INSERT INTO cg_symbols (rel_path, symbol_id, fq_name, short_name, scope_json) VALUES (?, ?, ?, ?, ?)",
      ["a.rb", "Legacy#run", "Legacy#run", "run", "[]"],
    );
    const rows = await db.queryAll<{ is_abstract_stub: boolean | null }>("SELECT is_abstract_stub FROM cg_symbols");
    expect(rows).toHaveLength(1);
    expect(rows[0].is_abstract_stub === true).toBe(false);
  });
});
