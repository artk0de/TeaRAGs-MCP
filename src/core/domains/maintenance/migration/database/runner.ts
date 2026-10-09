/**
 * Driver-agnostic SQL migration runner.
 *
 * Operates against any client matching `MigrationCapableClient` — slice 1
 * ships `DuckDbGraphClient`; slice 4's `PostgresGraphClient` plugs in
 * with no changes here. Each migration is applied once in `filename`
 * lexical order; applied filenames are recorded in `schema_migrations`
 * so reruns are no-ops.
 *
 * Migrations are passed in as an array of `DatabaseMigration` records —
 * `{ filename, sql }` for a static script, `{ filename, run }` for a
 * procedural step that reads the catalog before acting. Both kinds share one
 * filename order, one transaction per migration, and one ledger. They live as
 * TS modules under
 * `src/core/domains/maintenance/migration/database/migrations/` so the compiled
 * `build/` artifact ships them as JavaScript (tsc does not copy raw
 * SQL files). Tests may also pass a directory path; the runner then
 * reads `.sql` files from disk in lexical order.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface MigrationCapableClient {
  exec: (sql: string) => Promise<void>;
  run: (sql: string, params?: unknown[]) => Promise<void>;
  queryAll: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

/** A migration whose whole effect is one static SQL script (the `.sql` twin carries its bytes). */
export interface SqlDatabaseMigration {
  readonly filename: string;
  readonly sql: string;
}

/**
 * A migration whose effect depends on what the database holds — e.g. dropping
 * tables whose names are only known from the catalog (bd tea-rags-mcp-bdnfu).
 * `run` executes inside the same BEGIN/COMMIT as a SQL migration and is
 * recorded in `schema_migrations` under `filename` exactly like one; a throw
 * rolls back everything it did and leaves it unrecorded. It has no `.sql` twin.
 */
export interface ProceduralDatabaseMigration {
  readonly filename: string;
  readonly run: (client: MigrationCapableClient) => Promise<void>;
}

/** One ledger entry: discriminated by which of `sql` / `run` it carries. */
export type DatabaseMigration = SqlDatabaseMigration | ProceduralDatabaseMigration;

export function isSqlDatabaseMigration(migration: DatabaseMigration): migration is SqlDatabaseMigration {
  return "sql" in migration;
}

export async function runMigrations(
  client: MigrationCapableClient,
  source: string | readonly DatabaseMigration[],
): Promise<MigrationResult> {
  await client.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (filename VARCHAR PRIMARY KEY, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)",
  );
  const appliedRows = await client.queryAll<{ filename: string }>("SELECT filename FROM schema_migrations");
  const applied = new Set(appliedRows.map((r) => r.filename));

  const migrations = typeof source === "string" ? loadFromDisk(source) : [...source].sort(byFilename);

  const result: MigrationResult = { applied: [], skipped: [] };
  for (const migration of migrations) {
    const { filename } = migration;
    if (applied.has(filename)) {
      result.skipped.push(filename);
      continue;
    }
    await client.exec("BEGIN");
    try {
      await applyMigrationBody(client, migration);
      await client.run("INSERT INTO schema_migrations (filename) VALUES (?)", [filename]);
      await client.exec("COMMIT");
      result.applied.push(filename);
    } catch (err) {
      await client.exec("ROLLBACK");
      throw err;
    }
  }
  return result;
}

/** The migration's own effect, inside the caller's transaction. Both kinds handled; no third exists. */
async function applyMigrationBody(client: MigrationCapableClient, migration: DatabaseMigration): Promise<void> {
  if (isSqlDatabaseMigration(migration)) {
    await client.exec(migration.sql);
    return;
  }
  await migration.run(client);
}

function loadFromDisk(dir: string): SqlDatabaseMigration[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((filename) => ({ filename, sql: readFileSync(join(dir, filename), "utf8") }));
}

function byFilename(a: DatabaseMigration, b: DatabaseMigration): number {
  return a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0;
}
