import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DATABASE_MIGRATIONS } from "../../../../../../src/core/domains/maintenance/migration/database/migrations/index.js";

const DIR = "src/core/domains/maintenance/migration/database/migrations";

/**
 * Production loads only the `.ts` twin; the `.sql` exists for the directory
 * path `runMigrations` accepts in tests. A twin that drifts changes nothing at
 * runtime and fails no build, so this is the only place the pair is checked.
 */
describe("database migration .ts/.sql twins", () => {
  it("every registered migration's sql is byte-identical to its .sql twin", () => {
    for (const migration of DATABASE_MIGRATIONS) {
      const twin = readFileSync(join(DIR, migration.filename), "utf8");
      expect(twin, migration.filename).toBe(migration.sql);
    }
  });

  it("every .sql file on disk is registered exactly once, in filename order", () => {
    const onDisk = readdirSync(DIR)
      .filter((name) => name.endsWith(".sql"))
      .sort();
    expect(DATABASE_MIGRATIONS.map((m) => m.filename)).toEqual(onDisk);
  });
});
