import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import {
  runMigrations,
  type DatabaseMigration,
} from "../../../../../../src/core/domains/maintenance/migration/database/runner.js";

describe("runMigrations", () => {
  let tmp: string;
  let dbPath: string;
  let migDir: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "cg-mig-"));
    dbPath = join(tmp, "test.duckdb");
    migDir = join(tmp, "migrations");
    mkdirSync(migDir);
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("applies migrations in numeric order and records them in schema_migrations", async () => {
    writeFileSync(join(migDir, "002-second.sql"), "CREATE TABLE second_table (id INTEGER PRIMARY KEY);");
    writeFileSync(join(migDir, "001-first.sql"), "CREATE TABLE first_table (id INTEGER PRIMARY KEY);");

    const client = new DuckDbGraphClient({ path: dbPath });
    await client.init();
    await runMigrations(client, migDir);
    await client.close();

    const client2 = new DuckDbGraphClient({ path: dbPath });
    await client2.init();
    const applied = await client2.queryAll<{ filename: string }>(
      "SELECT filename FROM schema_migrations ORDER BY filename",
    );
    await client2.close();
    expect(applied.map((r) => r.filename)).toEqual(["001-first.sql", "002-second.sql"]);
  });

  it("is idempotent — re-running applies nothing", async () => {
    writeFileSync(join(migDir, "001-first.sql"), "CREATE TABLE first_table (id INTEGER PRIMARY KEY);");
    const client = new DuckDbGraphClient({ path: dbPath });
    await client.init();
    await runMigrations(client, migDir);
    const second = await runMigrations(client, migDir);
    await client.close();
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(["001-first.sql"]);
  });

  it("propagates SQL errors and rolls back the failing migration", async () => {
    writeFileSync(join(migDir, "001-bad.sql"), "CREATE TABLE bad (id INTEGER);");
    writeFileSync(join(migDir, "002-broken.sql"), "INVALID SQL HERE;");

    const client = new DuckDbGraphClient({ path: dbPath });
    await client.init();
    await expect(runMigrations(client, migDir)).rejects.toBeDefined();
    // First migration succeeded; second's filename must NOT appear in
    // schema_migrations because the rollback happened.
    const applied = await client.queryAll<{ filename: string }>(
      "SELECT filename FROM schema_migrations ORDER BY filename",
    );
    await client.close();
    expect(applied.map((r) => r.filename)).toEqual(["001-bad.sql"]);
  });

  describe("procedural migrations (bd tea-rags-mcp-bdnfu)", () => {
    it("applies a procedural migration once, records it, and skips it on re-run", async () => {
      let calls = 0;
      const migrations: DatabaseMigration[] = [
        {
          filename: "001-procedural.ts",
          run: async (c) => {
            calls++;
            await c.exec("CREATE TABLE made_by_code (id INTEGER)");
          },
        },
      ];
      const client = new DuckDbGraphClient({ path: dbPath });
      await client.init();
      const first = await runMigrations(client, migrations);
      const second = await runMigrations(client, migrations);
      const ledger = await client.queryAll<{ filename: string }>("SELECT filename FROM schema_migrations");
      const tables = await client.queryAll<{ table_name: string }>(
        "SELECT table_name FROM duckdb_tables() WHERE table_name = 'made_by_code'",
      );
      await client.close();

      expect(first).toEqual({ applied: ["001-procedural.ts"], skipped: [] });
      expect(second).toEqual({ applied: [], skipped: ["001-procedural.ts"] });
      expect(calls).toBe(1);
      expect(ledger.map((r) => r.filename)).toEqual(["001-procedural.ts"]);
      expect(tables).toHaveLength(1);
    });

    it("interleaves SQL and procedural migrations in filename order", async () => {
      const order: string[] = [];
      const migrations: DatabaseMigration[] = [
        { filename: "003-third.sql", sql: "CREATE TABLE third_table (id INTEGER);" },
        {
          filename: "002-second.ts",
          run: async (c) => {
            // 001 already ran: its table is visible to the procedure.
            const rows = await c.queryAll<{ n: number }>(
              "SELECT count(*)::INTEGER AS n FROM duckdb_tables() WHERE table_name = 'first_table'",
            );
            order.push(`002 sees first_table=${rows[0]?.n}`);
            const third = await c.queryAll<{ n: number }>(
              "SELECT count(*)::INTEGER AS n FROM duckdb_tables() WHERE table_name = 'third_table'",
            );
            order.push(`002 sees third_table=${third[0]?.n}`);
          },
        },
        { filename: "001-first.sql", sql: "CREATE TABLE first_table (id INTEGER);" },
      ];
      const client = new DuckDbGraphClient({ path: dbPath });
      await client.init();
      const outcome = await runMigrations(client, migrations);
      await client.close();

      expect(outcome.applied).toEqual(["001-first.sql", "002-second.ts", "003-third.sql"]);
      expect(order).toEqual(["002 sees first_table=1", "002 sees third_table=0"]);
    });

    it("rolls back a throwing procedural migration and leaves it unrecorded", async () => {
      const migrations: DatabaseMigration[] = [
        { filename: "001-first.sql", sql: "CREATE TABLE first_table (id INTEGER);" },
        {
          filename: "002-throws.ts",
          run: async (c) => {
            await c.exec("CREATE TABLE half_done (id INTEGER)");
            throw new Error("procedure failed");
          },
        },
      ];
      const client = new DuckDbGraphClient({ path: dbPath });
      await client.init();
      await expect(runMigrations(client, migrations)).rejects.toThrow("procedure failed");
      const ledger = await client.queryAll<{ filename: string }>(
        "SELECT filename FROM schema_migrations ORDER BY filename",
      );
      const halfDone = await client.queryAll<{ table_name: string }>(
        "SELECT table_name FROM duckdb_tables() WHERE table_name = 'half_done'",
      );
      await client.close();

      expect(ledger.map((r) => r.filename)).toEqual(["001-first.sql"]);
      expect(halfDone).toEqual([]);
    });
  });
});
