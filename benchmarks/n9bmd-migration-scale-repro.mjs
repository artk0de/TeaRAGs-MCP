/**
 * bd tea-rags-mcp-n9bmd — migration 027 scale repro, the ex28m discipline
 * (`benchmarks/ex28m-migration-scale-repro.mjs`) applied to
 * `cg_ambiguous_fanout`. Two questions, both answered on a file-backed DuckDB
 * under the daemon's own PRAGMAs (memory_limit 2GB, threads 2,
 * preserve_insertion_order false):
 *
 *   1. Does the rebuild lose rows at scale? It cannot: the new key
 *      (source_symbol_id, source_rel_path, call_expression) is a strict
 *      SUPERSET of 013's (source_symbol_id, call_expression), so rows distinct
 *      under the old key stay distinct and `INSERT OR IGNORE` has nothing to
 *      discard. `lost` must print 0.
 *   2. Does the defect reproduce, and does the new key fix it? The seed writes
 *      every aggregate from `--sources` distinct files, with a `--namesake-share`
 *      of rows emitted by ONE bare-name caller (`main`) through ONE call
 *      expression — the shape a top-level `main` in many entry files produces.
 *      Under 013 all of those collapse to one row; re-inserting them after the
 *      migration must keep one per file.
 *
 * The aggregate profile follows taxdome's `#firm` incident that created the
 * table (240-candidate fan-outs, multi-tenant models): short Ruby-style call
 * expressions, `member` from a small vocabulary, `candidate_count` 17–260.
 *
 * Measured 2026-09-23 (M-series, @duckdb/node-api as pinned, machine under
 * load average ~70 from a parallel agent wave — wall times are inflated, the
 * row counts are not):
 *
 *   rows       stored (013)  db size  migration  lost  namesake 013 → 027
 *   200,000    180,001       —        7.8s       0     1/1000 → 1000/1000
 *   1,000,000  900,001       106MB    33.6s      0     1/1000 → 1000/1000
 *
 * `stored` is short of `rows` by exactly the namesake share minus one: those
 * are the aggregates 013's key dropped at write time.
 *
 *   node benchmarks/n9bmd-migration-scale-repro.mjs [--rows N]
 *     [--namesake-share 0.1] [--sources 1000] [--mem 2GB] [--threads 2]
 */
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DuckDBInstance } from "@duckdb/node-api";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};

const ROWS = Number(arg("rows", 200000));
const NAMESAKE_SHARE = Number(arg("namesake-share", 0.1));
const SOURCE_FILES = Number(arg("sources", 1000));
const MEM = arg("mem", "2GB");
const THREADS = Number(arg("threads", 2));

// Verbatim migration 013's table (minus its cg_run_stats ALTER, irrelevant here).
const OLD_DDL = `
CREATE TABLE cg_ambiguous_fanout (
  source_symbol_id VARCHAR NOT NULL,
  source_rel_path VARCHAR NOT NULL,
  call_expression VARCHAR NOT NULL,
  member VARCHAR NOT NULL,
  candidate_count INTEGER NOT NULL,
  PRIMARY KEY (source_symbol_id, call_expression)
);
CREATE INDEX IF NOT EXISTS idx_cg_ambiguous_fanout_source_rel_path ON cg_ambiguous_fanout (source_rel_path);
CREATE INDEX IF NOT EXISTS idx_cg_ambiguous_fanout_member ON cg_ambiguous_fanout (member);
`;

// Verbatim migration 027.
const MIGRATION_027 = `
CREATE TABLE IF NOT EXISTS cg_ambiguous_fanout_v2 (
  source_symbol_id VARCHAR NOT NULL,
  source_rel_path  VARCHAR NOT NULL,
  call_expression  VARCHAR NOT NULL,
  member           VARCHAR NOT NULL,
  candidate_count  INTEGER NOT NULL,
  PRIMARY KEY (source_symbol_id, source_rel_path, call_expression)
);
INSERT OR IGNORE INTO cg_ambiguous_fanout_v2
  (source_symbol_id, source_rel_path, call_expression, member, candidate_count)
SELECT source_symbol_id, source_rel_path, call_expression, member, candidate_count
  FROM cg_ambiguous_fanout;
DROP TABLE cg_ambiguous_fanout;
ALTER TABLE cg_ambiguous_fanout_v2 RENAME TO cg_ambiguous_fanout;
CREATE INDEX IF NOT EXISTS idx_cg_ambiguous_fanout_source_rel_path
  ON cg_ambiguous_fanout (source_rel_path);
CREATE INDEX IF NOT EXISTS idx_cg_ambiguous_fanout_member
  ON cg_ambiguous_fanout (member);
`;

const MEMBERS = ["firm", "user", "account", "owner", "client", "settings", "call", "run"];

function row(j) {
  const file = j % SOURCE_FILES;
  const relPath = `app/models/tenant_${file}/model_${file}.rb`;
  if (j < Math.floor(ROWS * NAMESAKE_SHARE)) {
    // Namesake caller: one bare id + one call expression across every file.
    return ["main", relPath, "handler.run", "run", 40];
  }
  const member = MEMBERS[j % MEMBERS.length];
  return [`Model${file}#m${j}`, relPath, `record_${j}.${member}`, member, 17 + (j % 244)];
}

async function insertAll(conn, sql) {
  const BATCH = 500;
  for (let i = 0; i < ROWS; i += BATCH) {
    const values = [];
    const params = [];
    for (let j = i; j < Math.min(i + BATCH, ROWS); j++) {
      values.push("(?, ?, ?, ?, ?)");
      params.push(...row(j));
    }
    await conn.run(`${sql} VALUES ${values.join(", ")}`, params);
  }
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "n9bmd-"));
  const dbPath = join(dir, "repro.duckdb");
  const instance = await DuckDBInstance.create(dbPath, {});
  const conn = await instance.connect();

  await conn.run(`SET memory_limit = '${MEM}'`);
  await conn.run(`SET threads = ${THREADS}`);
  await conn.run(`SET preserve_insertion_order = false`);
  await conn.run(`SET temp_directory = '${join(dir, "spill")}'`);
  await conn.run(OLD_DDL);

  const namesakeRows = Math.floor(ROWS * NAMESAKE_SHARE);
  const namesakeFiles = Math.min(namesakeRows, SOURCE_FILES);
  process.stdout.write(
    `rows=${ROWS} namesakeShare=${NAMESAKE_SHARE} sources=${SOURCE_FILES} mem=${MEM} threads=${THREADS} db=file\n`,
  );

  const insert =
    "INSERT OR IGNORE INTO cg_ambiguous_fanout (source_symbol_id, source_rel_path, call_expression, member, candidate_count)";
  const scalar = async (sql) => Number((await conn.runAndReadAll(sql)).getRowObjectsJson()[0].n);
  const namesakeCount = () => scalar("SELECT COUNT(*) AS n FROM cg_ambiguous_fanout WHERE source_symbol_id = 'main'");

  const t0 = Date.now();
  await insertAll(conn, insert);
  const seedMs = Date.now() - t0;
  const before = await scalar("SELECT COUNT(*) AS n FROM cg_ambiguous_fanout");
  const namesakeBefore = await namesakeCount();
  const sizeMb = (statSync(dbPath).size / 1024 / 1024).toFixed(0);
  process.stdout.write(
    `seeded=${before} namesake=${namesakeBefore}/${namesakeFiles} files (013 key) db=${sizeMb}MB in ${seedMs}ms\n`,
  );
  process.stdout.write(namesakeBefore < namesakeFiles ? "defect REPRODUCED under 013\n" : "defect NOT reproduced\n");

  const t1 = Date.now();
  let err = null;
  try {
    await conn.run(MIGRATION_027);
  } catch (e) {
    err = e.message;
  }
  const migMs = Date.now() - t1;

  if (err) {
    process.stdout.write(`MIGRATION THREW after ${migMs}ms: ${err}\n`);
  } else {
    const after = await scalar("SELECT COUNT(*) AS n FROM cg_ambiguous_fanout");
    process.stdout.write(`after=${after} lost=${before - after} in ${migMs}ms\n`);

    // The writer re-walks: re-emit every row under the new key.
    await insertAll(conn, insert);
    const namesakeAfter = await namesakeCount();
    process.stdout.write(
      `re-walked namesake=${namesakeAfter}/${namesakeFiles} files (027 key) ` +
        `${namesakeAfter === namesakeFiles ? "FIXED" : "*** STILL COLLAPSED ***"}\n`,
    );
  }

  rmSync(dir, { recursive: true, force: true });
}

await main();
