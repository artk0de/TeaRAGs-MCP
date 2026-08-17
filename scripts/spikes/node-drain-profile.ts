/**
 * What the `cg_symbols` node drain costs, at taxdome scale (bd pass1-fanout).
 *
 * `scripts/spikes/pass1-fanout-profile.ts` measures the whole codegraph window
 * over this repository's own 922 TypeScript files. That corpus cannot show the
 * drain, because its `cg_symbols` never grows past a few tens of thousands of
 * rows and pass-2 dwarfs the write. The taxdome Ruby recompute is the opposite
 * shape — 8 811 files, a table well past 400k rows, and 146
 * `CODEGRAPH_NODES_FLUSH` calls that took 32s of serial DuckDB time, of which
 * 24.1s sat between the last extraction and the first `PASS2_PROGRESS` once the
 * pass-1 fan-out stopped hiding it behind the parse.
 *
 * So this script isolates the write and scales it. Everything below
 * `DuckDbGraphClient` is production code, including the migrations that decide
 * which indexes exist — migration 019 dropped every secondary index off
 * `cg_symbols`, which is precisely why the DELETE shape matters. Only the daemon
 * socket is absent; it adds one round-trip per call and does not change the
 * ratio between the shapes.
 *
 * Three questions, one run:
 *
 *   1. `shape` — the three write shapes this path has had, in order:
 *      `perFileDelete` (a `WHERE rel_path = ?` DELETE per file, then one batched
 *      INSERT), `setBasedDelete` (one `WHERE rel_path IN (…)` DELETE, then the
 *      same INSERT — bd pass1-fanout), and `rowDiff`, the shipped
 *      `upsertSymbolsBulk` (bd tea-rags-mcp-tslvq). The first two both re-insert
 *      every row they just deleted; only the third can leave an unchanged row
 *      alone, which on a recompute is nearly all of them.
 *   2. `cadence` — files per flush call (`CODEGRAPH_NODE_FLUSH_FILES`, default
 *      256). For the DELETE shapes a bigger batch saves round-trips but not
 *      scans or inserts. For `rowDiff` it INVERTS: the diff materialises its
 *      scope read per call, so a wide batch pays to pull thousands of rows into
 *      JS at once. Measured warm, 4 000 files: 851ms at cadence 60 against
 *      3 345ms at 256 — the opposite of how the DELETE shapes tune, and the
 *      reason the default deserves its own live measurement.
 *   3. `pass` — a cold table against a warm one. The recompute case is warm, and
 *      it is the one that costs. Cold numbers are noisy here: the table grows
 *      during the pass, so a scenario's scan cost depends on where in the run it
 *      is measured. Read the warm column.
 *
 *   npx tsx scripts/spikes/node-drain-profile.ts [--files N] [--defs N]
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { CG_SYMBOLS_DEF_COLUMNS, toCgSymbolsRow } from "../../src/core/adapters/duckdb/cg-symbols-row.js";
import { DuckDbGraphClient } from "../../src/core/adapters/duckdb/client.js";
import type { BulkSymbolUpsertEntry, SymbolDefinition } from "../../src/core/contracts/types/codegraph.js";
import { DATABASE_MIGRATIONS } from "../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../src/core/domains/maintenance/migration/database/runner.js";

interface Args {
  files: number;
  defs: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { files: 4000, defs: 25 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--files") args.files = Number(argv[++i]);
    else if (argv[i] === "--defs") args.defs = Number(argv[++i]);
  }
  return args;
}

/**
 * A Rails-shaped corpus: deep namespaced paths and long symbol ids, because both
 * are VARCHAR comparisons the scan pays for and a short synthetic id would
 * flatter the numbers.
 */
function corpus(args: Args): BulkSymbolUpsertEntry[] {
  const out: BulkSymbolUpsertEntry[] = [];
  for (let f = 0; f < args.files; f++) {
    const relPath = `app/models/namespace_${f % 40}/some_fairly_long_file_name_${f}.rb`;
    const definitions: SymbolDefinition[] = [];
    for (let d = 0; d < args.defs; d++) {
      definitions.push({
        relPath,
        symbolId: `Namespace${f % 40}::SomeClass${f}#method_number_${d}`,
        fqName: `Namespace${f % 40}::SomeClass${f}#method_number_${d}`,
        shortName: `method_number_${d}`,
        scope: [`Namespace${f % 40}`, `SomeClass${f}`],
      });
    }
    out.push({ relPath, definitions });
  }
  return out;
}

function chunked<T>(xs: readonly T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/** Chunk size the session's batched statements use — mirrored for the baselines. */
const STATEMENT_CHUNK_ROWS = 200;

/**
 * The two superseded write shapes, kept here as the baselines they are: a DELETE
 * of the file's rows (per file, then set-based) followed by a re-INSERT of the
 * whole set. Both reach past the client into its session on purpose — a
 * benchmark's baseline has to be the code that ran, not a paraphrase of it. The
 * set-based DELETE reproduces `deleteByScopeValuesBatched`, which the row diff
 * retired.
 */
async function writeDeleteThenInsert(
  client: DuckDbGraphClient,
  entries: BulkSymbolUpsertEntry[],
  deleteShape: "perFile" | "setBased",
): Promise<void> {
  const lastByRelPath = new Map<string, SymbolDefinition[]>();
  for (const { relPath, definitions } of entries) lastByRelPath.set(relPath, definitions);
  const relPaths = [...lastByRelPath.keys()];
  const { session } = client as unknown as { session: SessionShape };
  await session.transaction(async () => {
    if (deleteShape === "perFile") {
      for (const relPath of relPaths) {
        await session.run("DELETE FROM cg_symbols WHERE rel_path = ?", [relPath]);
      }
    } else {
      for (let i = 0; i < relPaths.length; i += STATEMENT_CHUNK_ROWS) {
        const chunk = relPaths.slice(i, i + STATEMENT_CHUNK_ROWS);
        await session.run(`DELETE FROM cg_symbols WHERE rel_path IN (${chunk.map(() => "?").join(", ")})`, chunk);
      }
    }
    const rows: unknown[][] = [];
    for (const definitions of lastByRelPath.values()) for (const def of definitions) rows.push(toCgSymbolsRow(def));
    await session.insertOrIgnoreBatched("cg_symbols", CG_SYMBOLS_DEF_COLUMNS, rows);
  });
}

interface SessionShape {
  transaction: <T>(body: () => Promise<T>) => Promise<T>;
  run: (sql: string, params?: unknown[]) => Promise<void>;
  insertOrIgnoreBatched: (
    table: string,
    columns: readonly string[],
    rows: readonly (readonly unknown[])[],
  ) => Promise<void>;
}

type WriteShape = "perFileDelete" | "setBasedDelete" | "rowDiff";

async function drain(client: DuckDbGraphClient, entries: BulkSymbolUpsertEntry[], cadence: number, shape: WriteShape) {
  const batches = chunked(entries, cadence);
  const started = performance.now();
  for (const batch of batches) {
    if (shape === "rowDiff") await client.upsertSymbolsBulk(batch);
    else await writeDeleteThenInsert(client, batch, shape === "perFileDelete" ? "perFile" : "setBased");
  }
  const wallMs = Math.round(performance.now() - started);
  return { wallMs, calls: batches.length, msPerCall: Math.round((wallMs / batches.length) * 10) / 10 };
}

async function scenario(entries: BulkSymbolUpsertEntry[], cadence: number, shape: WriteShape): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "node-drain-"));
  const client = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
  await client.init();
  await runMigrations(client, DATABASE_MIGRATIONS);
  try {
    const cold = await drain(client, entries, cadence, shape);
    const warm = await drain(client, entries, cadence, shape);
    process.stdout.write(
      `${JSON.stringify({
        shape,
        cadence,
        files: entries.length,
        // A first index, where every DELETE finds nothing.
        cold,
        // A recompute, which is what a `--force-enrichments codegraph` run is.
        warm,
      })}\n`,
    );
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const entries = corpus(args);
  process.stdout.write(
    `${JSON.stringify({ files: args.files, defsPerFile: args.defs, rows: args.files * args.defs })}\n`,
  );
  for (const cadence of [60, 256]) {
    for (const shape of ["perFileDelete", "setBasedDelete", "rowDiff"] as const) {
      await scenario(entries, cadence, shape);
    }
  }
}

void main().catch((err: unknown) => {
  process.stderr.write(`node-drain-profile failed: ${(err as Error).stack ?? String(err)}\n`);
  process.exitCode = 1;
});
