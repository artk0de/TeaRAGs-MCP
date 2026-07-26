/**
 * Driver-agnostic SQL migration runner.
 *
 * Operates against any client matching `MigrationCapableClient` — slice 1
 * ships `DuckDbGraphClient`; slice 4's `PostgresGraphClient` plugs in
 * with no changes here. Each migration is applied once in `filename`
 * lexical order; applied filenames are recorded in `schema_migrations`
 * so reruns are no-ops.
 *
 * Migrations are passed in as an array of `{ filename, sql }` records
 * — they live as TS modules under
 * `src/core/infra/migration/database/migrations/` so the compiled
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

export interface InlineMigration {
  filename: string;
  sql: string;
}

export async function runMigrations(
  client: MigrationCapableClient,
  source: string | InlineMigration[],
): Promise<MigrationResult> {
  await client.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (filename VARCHAR PRIMARY KEY, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)",
  );
  const appliedRows = await client.queryAll<{ filename: string }>("SELECT filename FROM schema_migrations");
  const applied = new Set(appliedRows.map((r) => r.filename));

  const migrations = typeof source === "string" ? loadFromDisk(source) : [...source].sort(byFilename);

  const result: MigrationResult = { applied: [], skipped: [] };
  for (const { filename, sql } of migrations) {
    if (applied.has(filename)) {
      result.skipped.push(filename);
      continue;
    }
    await client.exec("BEGIN");
    try {
      await client.exec(sql);
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

function loadFromDisk(dir: string): InlineMigration[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((filename) => ({ filename, sql: readFileSync(join(dir, filename), "utf8") }));
}

function byFilename(a: InlineMigration, b: InlineMigration): number {
  return a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0;
}
