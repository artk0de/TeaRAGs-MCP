import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeMigrationTwins } from "../../scripts/gen-migration-sql.js";

/**
 * The twins carry the template literal's bytes verbatim — leading newline and
 * all — because `sql-twins.test.ts` compares them with `toBe`. A generator that
 * trimmed, re-indented or appended a newline would turn the guard red on its
 * own output.
 */
const MIGRATIONS = [
  { filename: "001-first.sql", sql: "\nCREATE TABLE a (id INTEGER);\n" },
  { filename: "002-second.sql", sql: "\nALTER TABLE a ADD COLUMN b VARCHAR;\n" },
];

describe("writeMigrationTwins", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "migration-twins-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes every registered migration's sql byte-for-byte", () => {
    expect(writeMigrationTwins(dir, MIGRATIONS)).toEqual(["001-first.sql", "002-second.sql"]);

    for (const migration of MIGRATIONS) {
      expect(readFileSync(join(dir, migration.filename), "utf8")).toBe(migration.sql);
    }
  });

  it("rewrites only the twin that drifted", () => {
    writeMigrationTwins(dir, MIGRATIONS);
    writeFileSync(join(dir, "002-second.sql"), "\nALTER TABLE a ADD COLUMN b INTEGER;\n", "utf8");

    expect(writeMigrationTwins(dir, MIGRATIONS)).toEqual(["002-second.sql"]);
    expect(readFileSync(join(dir, "002-second.sql"), "utf8")).toBe(MIGRATIONS[1]?.sql);
  });

  it("reports nothing to do when every twin already matches", () => {
    writeMigrationTwins(dir, MIGRATIONS);

    expect(writeMigrationTwins(dir, MIGRATIONS)).toEqual([]);
  });
});
