/**
 * Regenerate the database migrations' `.sql` twins from their `.ts` strings.
 *
 * Every migration ships twice: `NNN-name.ts` exports the SQL as a template
 * literal (the only side production loads) and `NNN-name.sql` carries the same
 * bytes for the directory path `runMigrations` accepts in tests. The `.ts` is
 * the single source of truth, so the `.sql` is derived, not authored — edit the
 * template literal, run this, and the twin follows.
 *
 * `tests/core/domains/maintenance/migration/database/sql-twins.test.ts` stays
 * the check: this script is how you fix a divergence, not how you detect one —
 * and it only ever writes registered migrations, never pruning an orphan `.sql`
 * left behind by a rename, which that same guard catches on its second
 * assertion.
 *
 * Usage:
 *   npm run gen:migration-sql
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  DATABASE_MIGRATIONS,
  type DatabaseMigration,
} from "../src/core/domains/maintenance/migration/database/migrations/index.js";

const here = dirname(fileURLToPath(import.meta.url));

export const MIGRATIONS_DIR = resolve(here, "../src/core/domains/maintenance/migration/database/migrations");

/** The twin as it sits on disk, or null when it was never created. */
function readTwin(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Write each migration's `.sql` twin from its `.ts` string and return the
 * filenames that actually changed. A twin already carrying the right bytes is
 * left untouched, so a clean run reports an empty list and leaves no mtime
 * churn behind — the guard test's "no diff expected" is observable from here.
 */
export function writeMigrationTwins(
  dir: string = MIGRATIONS_DIR,
  migrations: readonly DatabaseMigration[] = DATABASE_MIGRATIONS,
): string[] {
  const rewritten: string[] = [];
  for (const migration of migrations) {
    const path = join(dir, migration.filename);
    if (readTwin(path) === migration.sql) continue;
    writeFileSync(path, migration.sql, "utf8");
    rewritten.push(migration.filename);
  }
  return rewritten;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rewritten = writeMigrationTwins();
  console.log(
    rewritten.length === 0
      ? `✓ ${DATABASE_MIGRATIONS.length} migration .sql twins already match their .ts strings.`
      : `✓ regenerated ${rewritten.length} of ${DATABASE_MIGRATIONS.length} migration .sql twins: ${rewritten.join(", ")}`,
  );
}
