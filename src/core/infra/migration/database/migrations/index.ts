/**
 * Migration registry — ordered list of SQL migrations applied by the
 * generic `runMigrations` runner. Add new migrations at the bottom with
 * the next numeric prefix.
 */
import { SQL_001_CG_SYMBOLS_INIT } from "./001-cg-symbols-init.js";
import { SQL_002_CG_SYMBOLS_TABLE } from "./002-cg-symbols-table.js";
import { SQL_003_CG_SYMBOLS_CYCLES } from "./003-cg-symbols-cycles.js";
import { SQL_004_CG_SYMBOLS_METRICS } from "./004-cg-symbols-metrics.js";
import { SQL_005_CG_SYMBOLS_INHERITANCE } from "./005-cg-symbols-inheritance.js";
import { SQL_006_CG_EDGE_KIND } from "./006-cg-edge-kind.js";
import { SQL_007_CG_SYMBOLS_CHUNK_ID } from "./007-cg-symbols-chunk-id.js";
import { SQL_008_CG_RUN_STATS_EXTERNAL } from "./008-cg-run-stats-external.js";

export interface DatabaseMigration {
  filename: string;
  sql: string;
}

export const DATABASE_MIGRATIONS: DatabaseMigration[] = [
  { filename: "001-cg-symbols-init.sql", sql: SQL_001_CG_SYMBOLS_INIT },
  { filename: "002-cg-symbols-table.sql", sql: SQL_002_CG_SYMBOLS_TABLE },
  { filename: "003-cg-symbols-cycles.sql", sql: SQL_003_CG_SYMBOLS_CYCLES },
  { filename: "004-cg-symbols-metrics.sql", sql: SQL_004_CG_SYMBOLS_METRICS },
  { filename: "005-cg-symbols-inheritance.sql", sql: SQL_005_CG_SYMBOLS_INHERITANCE },
  { filename: "006-cg-edge-kind.sql", sql: SQL_006_CG_EDGE_KIND },
  { filename: "007-cg-symbols-chunk-id.sql", sql: SQL_007_CG_SYMBOLS_CHUNK_ID },
  { filename: "008-cg-run-stats-external.sql", sql: SQL_008_CG_RUN_STATS_EXTERNAL },
];
