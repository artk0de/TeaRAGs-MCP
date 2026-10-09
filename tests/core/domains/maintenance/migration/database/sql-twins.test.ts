import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DATABASE_MIGRATIONS } from "../../../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { isSqlDatabaseMigration } from "../../../../../../src/core/domains/maintenance/migration/database/runner.js";

const DIR = "src/core/domains/maintenance/migration/database/migrations";

/** SQL migrations carry a twin; procedural ones (`run`, bd tea-rags-mcp-bdnfu) have no SQL text to mirror. */
const SQL_MIGRATIONS = DATABASE_MIGRATIONS.filter(isSqlDatabaseMigration);
const PROCEDURAL_MIGRATIONS = DATABASE_MIGRATIONS.filter((migration) => !isSqlDatabaseMigration(migration));

/**
 * Production loads only the `.ts` twin; the `.sql` exists for the directory
 * path `runMigrations` accepts in tests. A twin that drifts changes nothing at
 * runtime and fails no build, so this is the only place the pair is checked.
 */
describe("database migration .ts/.sql twins", () => {
  it("every registered SQL migration's sql is byte-identical to its .sql twin", () => {
    for (const migration of SQL_MIGRATIONS) {
      const twin = readFileSync(join(DIR, migration.filename), "utf8");
      expect(twin, migration.filename).toBe(migration.sql);
    }
  });

  it("every .sql file on disk is registered exactly once, in filename order", () => {
    const onDisk = readdirSync(DIR)
      .filter((name) => name.endsWith(".sql"))
      .sort();
    expect(SQL_MIGRATIONS.map((m) => m.filename)).toEqual(onDisk);
  });

  it("a procedural migration has no .sql twin — its ledger key names its own module", () => {
    for (const migration of PROCEDURAL_MIGRATIONS) {
      expect(migration.filename, migration.filename).toMatch(/^\d{3}-[a-z0-9-]+\.ts$/);
      expect(existsSync(join(DIR, migration.filename)), migration.filename).toBe(true);
      expect(existsSync(join(DIR, migration.filename.replace(/\.ts$/, ".sql"))), migration.filename).toBe(false);
    }
  });

  it("the registry as a whole is in strict filename order", () => {
    const names = DATABASE_MIGRATIONS.map((m) => m.filename);
    expect(names).toEqual([...new Set(names)].sort());
  });
});
