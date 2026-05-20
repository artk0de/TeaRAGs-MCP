/**
 * Migration registry — ordered list of SQL migrations applied by the
 * generic `runMigrations` runner. Add new migrations at the bottom with
 * the next numeric prefix.
 */
import { SQL_001_CG_SYMBOLS_INIT } from "./001-cg-symbols-init.js";
import { SQL_002_CG_SYMBOLS_TABLE } from "./002-cg-symbols-table.js";
import { SQL_003_CG_SYMBOLS_CYCLES } from "./003-cg-symbols-cycles.js";
import { SQL_004_CG_SYMBOLS_METRICS } from "./004-cg-symbols-metrics.js";

export interface DatabaseMigration {
  filename: string;
  sql: string;
}

export const DATABASE_MIGRATIONS: DatabaseMigration[] = [
  { filename: "001-cg-symbols-init.sql", sql: SQL_001_CG_SYMBOLS_INIT },
  { filename: "002-cg-symbols-table.sql", sql: SQL_002_CG_SYMBOLS_TABLE },
  { filename: "003-cg-symbols-cycles.sql", sql: SQL_003_CG_SYMBOLS_CYCLES },
  { filename: "004-cg-symbols-metrics.sql", sql: SQL_004_CG_SYMBOLS_METRICS },
];
