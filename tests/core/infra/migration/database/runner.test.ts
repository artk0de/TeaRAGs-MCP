import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../../src/core/adapters/duckdb/client.js";
import { runMigrations } from "../../../../../src/core/infra/migration/database/runner.js";

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
});
