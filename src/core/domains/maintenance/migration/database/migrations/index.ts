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
import { SQL_009_CG_RUN_STATS_LANGUAGE } from "./009-cg-run-stats-language.js";
import { SQL_010_CG_RUN_STATS_UNRESOLVABLE } from "./010-cg-run-stats-unresolvable.js";
import { SQL_011_CG_RUN_STATS_NO_IN_PROJECT_DEF } from "./011-cg-run-stats-no-in-project-def.js";
import { SQL_012_CG_SYMBOLS_ARITY_VISIBILITY } from "./012-cg-symbols-arity-visibility.js";
import { SQL_013_CG_AMBIGUOUS_FANOUT } from "./013-cg-ambiguous-fanout.js";
import { SQL_014_CG_METHOD_EDGES_SOURCE_PATH_INDEX } from "./014-cg-method-edges-source-path-index.js";
import { SQL_015_CG_RUN_STATS_CORE_AMBIGUOUS } from "./015-cg-run-stats-core-ambiguous.js";
import { SQL_016_CG_SYMBOLS_ABSTRACT_STUB } from "./016-cg-symbols-abstract-stub.js";
import { SQL_017_CG_SYMBOLS_FILES_CONTENT_HASH } from "./017-cg-symbols-files-content-hash.js";
import { SQL_018_CG_CYCLES_DROP_SECONDARY_INDEXES } from "./018-cg-cycles-drop-secondary-indexes.js";
import { SQL_019_CG_DROP_UNEARNED_SECONDARY_INDEXES } from "./019-cg-drop-unearned-secondary-indexes.js";
import { SQL_020_CG_METHOD_EDGES_SOURCE_PATH_PK } from "./020-cg-method-edges-source-path-pk.js";
import { SQL_021_CG_PASS1_AGGREGATES } from "./021-cg-pass1-aggregates.js";
import { SQL_022_CG_RUN_STATS_UNNARROWED_TEMPLATE } from "./022-cg-run-stats-unnarrowed-template.js";
import { SQL_023_CG_SIGNALS_PREV } from "./023-cg-signals-prev.js";
import { SQL_024_CG_SYMBOLS_LINE_RANGE } from "./024-cg-symbols-line-range.js";
import { SQL_025_CG_FILE_RESOLVE_STATS } from "./025-cg-file-resolve-stats.js";
import { SQL_026_CG_METHOD_EDGES_NULLABLE_TARGET } from "./026-cg-method-edges-nullable-target.js";

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
  { filename: "009-cg-run-stats-language.sql", sql: SQL_009_CG_RUN_STATS_LANGUAGE },
  { filename: "010-cg-run-stats-unresolvable.sql", sql: SQL_010_CG_RUN_STATS_UNRESOLVABLE },
  { filename: "011-cg-run-stats-no-in-project-def.sql", sql: SQL_011_CG_RUN_STATS_NO_IN_PROJECT_DEF },
  { filename: "012-cg-symbols-arity-visibility.sql", sql: SQL_012_CG_SYMBOLS_ARITY_VISIBILITY },
  { filename: "013-cg-ambiguous-fanout.sql", sql: SQL_013_CG_AMBIGUOUS_FANOUT },
  { filename: "014-cg-method-edges-source-path-index.sql", sql: SQL_014_CG_METHOD_EDGES_SOURCE_PATH_INDEX },
  { filename: "015-cg-run-stats-core-ambiguous.sql", sql: SQL_015_CG_RUN_STATS_CORE_AMBIGUOUS },
  { filename: "016-cg-symbols-abstract-stub.sql", sql: SQL_016_CG_SYMBOLS_ABSTRACT_STUB },
  { filename: "017-cg-symbols-files-content-hash.sql", sql: SQL_017_CG_SYMBOLS_FILES_CONTENT_HASH },
  { filename: "018-cg-cycles-drop-secondary-indexes.sql", sql: SQL_018_CG_CYCLES_DROP_SECONDARY_INDEXES },
  { filename: "019-cg-drop-unearned-secondary-indexes.sql", sql: SQL_019_CG_DROP_UNEARNED_SECONDARY_INDEXES },
  { filename: "020-cg-method-edges-source-path-pk.sql", sql: SQL_020_CG_METHOD_EDGES_SOURCE_PATH_PK },
  { filename: "021-cg-pass1-aggregates.sql", sql: SQL_021_CG_PASS1_AGGREGATES },
  { filename: "022-cg-run-stats-unnarrowed-template.sql", sql: SQL_022_CG_RUN_STATS_UNNARROWED_TEMPLATE },
  { filename: "023-cg-signals-prev.sql", sql: SQL_023_CG_SIGNALS_PREV },
  { filename: "024-cg-symbols-line-range.sql", sql: SQL_024_CG_SYMBOLS_LINE_RANGE },
  { filename: "025-cg-file-resolve-stats.sql", sql: SQL_025_CG_FILE_RESOLVE_STATS },
  { filename: "026-cg-method-edges-nullable-target.sql", sql: SQL_026_CG_METHOD_EDGES_NULLABLE_TARGET },
];
