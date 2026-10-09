/**
 * Codegraph schema — drop the legacy per-review edge tables (bd tea-rags-mcp-bdnfu).
 *
 * Builds older than bd tea-rags-mcp-xi2r9 D4 created one PERSISTENT
 * `cg_review_file_edges_<reviewId>` table per review in the database file; the
 * review id embeds an epoch, so every name is distinct and none is known
 * statically. Their only remover — the review-edge store's age sweep — was
 * deleted with the store (35.20), so a database written by such a build keeps
 * them forever. Reviews now use TEMP tables, which this migration never sees.
 *
 * PROCEDURAL, not SQL: the table names come from the catalog, so there is no
 * static script and no `.sql` twin. It runs once, inside the runner's
 * transaction, and is recorded in `schema_migrations` like any SQL migration.
 * Identifiers are re-quoted with doubling (the deleted sweep's quoting), so even
 * a hostile name in our own database cannot leave the identifier.
 */

import type { MigrationCapableClient } from "../runner.js";

/** The per-review table-name prefix the legacy builds wrote. */
const LEGACY_REVIEW_EDGE_TABLE_PREFIX = "cg_review_file_edges_";

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

export async function dropLegacyReviewEdgeTables(client: MigrationCapableClient): Promise<void> {
  const rows = await client.queryAll<{ database_name: string; table_name: string }>(
    "SELECT database_name, table_name FROM duckdb_tables() " +
      "WHERE schema_name = 'main' AND NOT temporary AND database_name = current_database() " +
      "AND starts_with(table_name, ?) ORDER BY table_name",
    [LEGACY_REVIEW_EDGE_TABLE_PREFIX],
  );
  for (const { database_name: database, table_name: name } of rows) {
    await client.exec(`DROP TABLE IF EXISTS ${quoteIdentifier(database)}.main.${quoteIdentifier(name)}`);
  }
}
