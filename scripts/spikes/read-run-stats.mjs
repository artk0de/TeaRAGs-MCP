/**
 * Diagnostic ONLY: read `cg_run_stats` read-only, bypassing the codegraph daemon.
 *
 * `DEBUG=1 tea-rags prime` is the supported read path for these numbers. Use this
 * only when the daemon cannot serve the read (e.g. a stale-build conflict from a
 * parallel session), and cross-check anything it prints against a probe run.
 *
 * Usage: node scripts/spikes/read-run-stats.mjs <path-to.duckdb>
 */
import { DuckDBInstance } from "@duckdb/node-api";

const dbPath = process.argv[2];
const instance = await DuckDBInstance.create(dbPath, { access_mode: "READ_ONLY" });
const connection = await instance.connect();
const reader = await connection.runAndReadAll(
  "SELECT language, receiver_kind, attempted, resolved, external_skipped, unresolvable, no_in_project_def, core_ambiguous, ambiguous_fanout FROM cg_run_stats ORDER BY language, attempted DESC",
);
const rows = reader.getRowObjectsJS();
process.stdout.write(`rows ${rows.length}\n`);
for (const row of rows) process.stdout.write(`${JSON.stringify(row)}\n`);
