/**
 * Graph DDL entry point.
 *
 * `createDatabaseMigrationApplier()` is what the composition root hands to the
 * DuckDB pool; `DATABASE_MIGRATIONS_MODULE_URL` is what the daemon spawner
 * passes across the process boundary, since the daemon runs in its own process
 * and creates graph databases itself (module-path DI, the same pattern the
 * worker threads use — see `.claude/rules/domains-language.md` §2).
 */

import type { DatabaseMigrationApplier } from "../../../../contracts/types/migration.js";

import { DATABASE_MIGRATIONS } from "./migrations/index.js";
import { runMigrations } from "./runner.js";

export { DATABASE_MIGRATIONS } from "./migrations/index.js";
export { runMigrations } from "./runner.js";

/** URL of THIS module — the daemon dynamic-imports it to get the two exports above. */
export const DATABASE_MIGRATIONS_MODULE_URL = import.meta.url;

export function createDatabaseMigrationApplier(): DatabaseMigrationApplier {
  return async (client) => {
    await runMigrations(client, DATABASE_MIGRATIONS);
  };
}
