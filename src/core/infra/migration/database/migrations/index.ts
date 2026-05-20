/**
 * Migration registry — ordered list of SQL migrations applied by the
 * generic `runMigrations` runner. Add new migrations at the bottom with
 * the next numeric prefix.
 */
import { SQL_001_CG_SYMBOLS_INIT } from "./001-cg-symbols-init.js";

export interface DatabaseMigration {
  filename: string;
  sql: string;
}

export const DATABASE_MIGRATIONS: DatabaseMigration[] = [
  { filename: "001-cg-symbols-init.sql", sql: SQL_001_CG_SYMBOLS_INIT },
];
