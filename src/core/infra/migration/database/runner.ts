/**
 * Driver-agnostic SQL migration runner.
 *
 * Operates against any client matching `MigrationCapableClient` — slice 1
 * ships `DuckDbGraphClient`; slice 4's `PostgresGraphClient` plugs in
 * with no changes here. Each `.sql` file under the migration directory
 * is applied once in numeric/lexical order; applied filenames are
 * recorded in `schema_migrations` so reruns are no-ops.
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

export async function runMigrations(client: MigrationCapableClient, dir: string): Promise<MigrationResult> {
  await client.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (filename VARCHAR PRIMARY KEY, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)",
  );
  const appliedRows = await client.queryAll<{ filename: string }>("SELECT filename FROM schema_migrations");
  const applied = new Set(appliedRows.map((r) => r.filename));
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const result: MigrationResult = { applied: [], skipped: [] };
  for (const filename of files) {
    if (applied.has(filename)) {
      result.skipped.push(filename);
      continue;
    }
    const sql = readFileSync(join(dir, filename), "utf8");
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
