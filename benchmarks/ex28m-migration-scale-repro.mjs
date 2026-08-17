/**
 * bd tea-rags-mcp-ex28m — migration 020 scale repro. KEEPS A NEGATIVE RESULT
 * REPRODUCIBLE, so 020 does not get re-suspected on the next incident.
 *
 * On 2026-08-17 taxdome's TS edge count was found at 58,602 against a ~99,583
 * baseline, with the JSX hubs gutted (ui-kit `Button` incoming 1,175 → 7,
 * react-app `Modal` ~154 → 1). Migration 020 had run on that DB the same
 * morning and was the prime suspect. It is not the cause.
 *
 * Profile taken from the forensics rather than invented: ~1,000 DISTINCT source
 * files, bare-name (namesake) source symbols, half the rows pointing at ONE
 * shared bare-name target — the `Button` hub — with multiline JSX call
 * expressions, the rest unique targets. File-backed DuckDB under the daemon's
 * own PRAGMAs (memory_limit 2GB, threads 2, preserve_insertion_order false).
 *
 * Measured (M-series, @duckdb/node-api as pinned):
 *
 *   rows        hub rows   db size   migration   lost
 *   100,000     —          —         2.4s        0
 *   500,000     250,000    113MB     1.9s        0
 *   1,500,000   750,000    318MB     4.5s        0
 *
 * The negative is not luck, and the keys say why: the new PRIMARY KEY
 * (source_symbol_id, source_rel_path, call_expression, target_symbol_id) is a
 * strict SUPERSET of the old (source_symbol_id, call_expression,
 * target_symbol_id). Two rows distinct under the old key are therefore distinct
 * under the new one, so the rebuild's `INSERT OR IGNORE` has nothing to
 * discard — it cannot lose a row at ANY scale. Run this before suspecting it.
 *
 *   node benchmarks/ex28m-migration-scale-repro.mjs [--rows N] [--hub-share 0.5]
 *     [--sources 1000] [--mem 2GB] [--threads 2]
 */
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DuckDBInstance } from "@duckdb/node-api";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};

const ROWS = Number(arg("rows", 500000));
const HUB_SHARE = Number(arg("hub-share", 0.5));
const SOURCE_FILES = Number(arg("sources", 1000));
const MEM = arg("mem", "2GB");
const THREADS = Number(arg("threads", 2));

const OLD_DDL = `
CREATE TABLE cg_symbols_edges_method (
  source_symbol_id VARCHAR NOT NULL,
  source_rel_path  VARCHAR NOT NULL,
  target_symbol_id VARCHAR,
  target_rel_path  VARCHAR NOT NULL,
  call_expression  VARCHAR NOT NULL,
  edge_kind        VARCHAR DEFAULT 'exact',
  confidence       REAL DEFAULT 1.0,
  PRIMARY KEY (source_symbol_id, call_expression, target_symbol_id)
);
CREATE INDEX IF NOT EXISTS idx_cg_symbols_edges_method_target_symbol
  ON cg_symbols_edges_method (target_symbol_id);
CREATE INDEX IF NOT EXISTS idx_cg_symbols_edges_method_target_rel_path
  ON cg_symbols_edges_method (target_rel_path);
CREATE INDEX IF NOT EXISTS idx_cg_symbols_edges_method_source_rel_path
  ON cg_symbols_edges_method (source_rel_path);
`;

// Verbatim migration 020 as shipped in 4df1e9ac5.
const MIGRATION_020 = `
CREATE TABLE IF NOT EXISTS cg_symbols_edges_method_v2 (
  source_symbol_id VARCHAR NOT NULL,
  source_rel_path  VARCHAR NOT NULL,
  target_symbol_id VARCHAR,
  target_rel_path  VARCHAR NOT NULL,
  call_expression  VARCHAR NOT NULL,
  edge_kind        VARCHAR DEFAULT 'exact',
  confidence       REAL DEFAULT 1.0,
  PRIMARY KEY (source_symbol_id, source_rel_path, call_expression, target_symbol_id)
);
INSERT OR IGNORE INTO cg_symbols_edges_method_v2
  (source_symbol_id, source_rel_path, target_symbol_id, target_rel_path, call_expression, edge_kind, confidence)
SELECT source_symbol_id, source_rel_path, target_symbol_id, target_rel_path, call_expression, edge_kind, confidence
  FROM cg_symbols_edges_method;
DROP TABLE cg_symbols_edges_method;
ALTER TABLE cg_symbols_edges_method_v2 RENAME TO cg_symbols_edges_method;
CREATE INDEX IF NOT EXISTS idx_cg_symbols_edges_method_target_symbol
  ON cg_symbols_edges_method (target_symbol_id);
CREATE INDEX IF NOT EXISTS idx_cg_symbols_edges_method_target_rel_path
  ON cg_symbols_edges_method (target_rel_path);
CREATE INDEX IF NOT EXISTS idx_cg_symbols_edges_method_source_rel_path
  ON cg_symbols_edges_method (source_rel_path);
`;

/** Real multiline JSX shape; hub sites share a long prefix and diverge late. */
function hubCallExpression(i) {
  return (
    `<Button\n` +
    `  variant="primary"\n` +
    `  size="medium"\n` +
    `  className={classNames(styles.root, styles.variantPrimary, {\n` +
    `    [styles.disabled]: isDisabled,\n` +
    `    [styles.loading]: isLoading,\n` +
    `  })}\n` +
    `  onClick={() => handleAction(${i})}\n` +
    `  data-test="confirm-${i}"\n` +
    `/>`
  );
}

function uniqueCallExpression(i) {
  return `<Widget${i} prop={${i}} />`;
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "ex28m-e2-"));
  const dbPath = join(dir, "repro.duckdb");
  const instance = await DuckDBInstance.create(dbPath, {});
  const conn = await instance.connect();

  await conn.run(`SET memory_limit = '${MEM}'`);
  await conn.run(`SET threads = ${THREADS}`);
  await conn.run(`SET preserve_insertion_order = false`);
  await conn.run(`SET temp_directory = '${join(dir, "spill")}'`);
  await conn.run(OLD_DDL);

  process.stdout.write(
    `rows=${ROWS} hubShare=${HUB_SHARE} sources=${SOURCE_FILES} mem=${MEM} threads=${THREADS} db=file\n`,
  );

  const t0 = Date.now();
  const BATCH = 200;
  const hubCount = Math.floor(ROWS * HUB_SHARE);
  for (let i = 0; i < ROWS; i += BATCH) {
    const values = [];
    const params = [];
    for (let j = i; j < Math.min(i + BATCH, ROWS); j++) {
      values.push("(?, ?, ?, ?, ?, 'exact', 1.0)");
      const isHub = j < hubCount;
      // Distinct source FILE per component, bare-name source symbol (namesakes).
      const srcFile = `app/javascript/react-app/components/C${j % SOURCE_FILES}/C${j % SOURCE_FILES}.tsx`;
      params.push(
        `C${j % SOURCE_FILES}`,
        srcFile,
        isHub ? "Button" : `Widget${j}`,
        isHub ? "app/javascript/ui-kit/components/Button/Button.tsx" : `app/javascript/w/W${j}.tsx`,
        isHub ? hubCallExpression(j) : uniqueCallExpression(j),
      );
    }
    await conn.run(
      `INSERT OR IGNORE INTO cg_symbols_edges_method
         (source_symbol_id, source_rel_path, target_symbol_id, target_rel_path, call_expression, edge_kind, confidence)
       VALUES ${values.join(", ")}`,
      params,
    );
  }
  const seedMs = Date.now() - t0;

  const scalar = async (sql) => Number((await conn.runAndReadAll(sql)).getRowObjectsJson()[0].n);

  const before = await scalar("SELECT COUNT(*) AS n FROM cg_symbols_edges_method");
  const hubBefore = await scalar("SELECT COUNT(*) AS n FROM cg_symbols_edges_method WHERE target_symbol_id = 'Button'");
  const sizeMb = (statSync(dbPath).size / 1024 / 1024).toFixed(0);
  process.stdout.write(`seeded=${before} hub=${hubBefore} db=${sizeMb}MB in ${seedMs}ms\n`);

  const t1 = Date.now();
  let err = null;
  try {
    await conn.run(MIGRATION_020);
  } catch (e) {
    err = e.message;
  }
  const migMs = Date.now() - t1;

  if (err) {
    process.stdout.write(`MIGRATION THREW after ${migMs}ms: ${err}\n`);
  } else {
    const after = await scalar("SELECT COUNT(*) AS n FROM cg_symbols_edges_method");
    const hubAfter = await scalar(
      "SELECT COUNT(*) AS n FROM cg_symbols_edges_method WHERE target_symbol_id = 'Button'",
    );
    const lost = before - after;
    const hubLost = hubBefore - hubAfter;
    process.stdout.write(
      `after=${after} lost=${lost} (${before ? ((lost / before) * 100).toFixed(2) : 0}%) ` +
        `hubAfter=${hubAfter} hubLost=${hubLost} in ${migMs}ms\n`,
    );
    process.stdout.write(lost > 0 ? "*** REPRODUCED ***\n" : "not reproduced\n");
  }

  rmSync(dir, { recursive: true, force: true });
}

await main();
