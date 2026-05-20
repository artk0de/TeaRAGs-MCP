/**
 * Migration registry — ordered list of SQL migrations applied by the
 * generic `runMigrations` runner. Add new migrations at the bottom with
 * the next numeric prefix.
 */
import { SQL_001_CG_SYMBOLS_INIT } from "./001-cg-symbols-init.js";
import { SQL_002_CG_SYMBOLS_TABLE } from "./002-cg-symbols-table.js";

export interface DatabaseMigration {
  filename: string;
  sql: string;
}

export const DATABASE_MIGRATIONS: DatabaseMigration[] = [
  { filename: "001-cg-symbols-init.sql", sql: SQL_001_CG_SYMBOLS_INIT },
  { filename: "002-cg-symbols-table.sql", sql: SQL_002_CG_SYMBOLS_TABLE },
];
