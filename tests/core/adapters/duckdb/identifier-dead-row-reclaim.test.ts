/**
 * `cg_identifiers` keeps no dead row VERSIONS (epic tea-rags-mcp-4p3sb).
 *
 * Invariant: no row outlives its source — here in its storage form. Deleting a
 * row is not enough if the file keeps the deleted version: bd tea-rags-mcp-dvzdm
 * (fix b53f5faf4) measured taxdome's graph at 1.27 GB for ~297 MB of live data,
 * because DuckDB 1.5.3 vacuums deletes at CHECKPOINT only for tables WITHOUT an
 * index, and every other `cg_*` table carries a PRIMARY KEY. Those tables are
 * handled by `recreateEmptyTable` (wholesale writers) and `compactStorage`
 * (per-file writers); see `wholesale-table-reclaim.test.ts`.
 *
 * `cg_identifiers` (migration 033) is the one codegraph table deliberately built
 * WITHOUT a key or index, so it needs neither: its per-file DELETEs are
 * reclaimed by the ordinary checkpoint. What these pin:
 *
 *  (a) the table has no index — the precondition. Adding one (a PK, or an index
 *      "for the GROUP BY reads") silently moves the table into the dvzdm class;
 *      the stored/live check in (c) is what fails then, and it says so.
 *  (b) no writer rewrites it wholesale: every DELETE is scoped to named files.
 *      A `--force-enrichments codegraph` recompute re-walks every file through
 *      the same `replaceIdentifiersBulk`, which skips a file whose rows did not
 *      move — so it needs no `recreateEmptyTable`.
 *  (c) repeated incremental runs rewriting the same files keep stored row
 *      versions equal to live rows after a checkpoint.
 *
 * Out of scope — bd tea-rags-mcp-a2ddb (codegraph payload stale in Qdrant for
 * files that stopped changing): `cg_identifiers` is read by the naming-lexicon
 * queries only and writes no Qdrant payload (pinned in
 * `provider-dead-symbols.test.ts`).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import { DuckDbGraphSession } from "../../../../src/core/adapters/duckdb/graph-session.js";
import type { IdentifierRow } from "../../../../src/core/contracts/types/codegraph.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/domains/maintenance/migration/database/runner.js";

const FILES = 60;
const ROWS_PER_FILE = 8;
const RUNS = 6;

function rowsFor(file: number, generation: number): IdentifierRow[] {
  return Array.from({ length: ROWS_PER_FILE }, (_, i) => ({
    ownerSymbolId: `S${file}#m${i % 3}`,
    kind: i % 2 === 0 ? "param" : "local",
    name: `v${i}_g${generation}`,
    line: i + 1,
  }));
}

describe("cg_identifiers reclaims what it deletes (dvzdm class)", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-ident-reclaim-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
    await runMigrations(db, DATABASE_MIGRATIONS);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function storedVsLive(): Promise<{ stored: number; live: number }> {
    const [stored] = await db.queryAll<{ n: number | bigint }>(
      "SELECT estimated_size AS n FROM duckdb_tables() WHERE table_name = 'cg_identifiers'",
    );
    const [live] = await db.queryAll<{ n: number | bigint }>("SELECT count(*) AS n FROM cg_identifiers");
    return { stored: Number(stored?.n ?? -1), live: Number(live?.n ?? -1) };
  }

  it("(a) carries no index and no key — the reason its deletes are vacuumed at checkpoint", async () => {
    const indexes = await db.queryAll("SELECT index_name FROM duckdb_indexes() WHERE table_name = 'cg_identifiers'");
    const keys = await db.queryAll<{ constraint_type: string }>(
      "SELECT constraint_type FROM duckdb_constraints() WHERE table_name = 'cg_identifiers'",
    );
    expect(indexes, "an index on cg_identifiers puts it in the dvzdm dead-row class").toEqual([]);
    expect(keys.map((k) => k.constraint_type).filter((t) => t === "PRIMARY KEY" || t === "UNIQUE")).toEqual([]);
  });

  it("(b) every DELETE a write issues is scoped to the files it names, never the whole table", async () => {
    const deletes: string[] = [];
    const { run } = DuckDbGraphSession.prototype;
    vi.spyOn(DuckDbGraphSession.prototype, "run").mockImplementation(async function (
      this: DuckDbGraphSession,
      sql: string,
      params: unknown[] = [],
    ) {
      if (/^DELETE FROM cg_identifiers\b/.test(sql)) deletes.push(sql);
      return run.call(this, sql, params);
    });
    const recreate = vi.spyOn(DuckDbGraphSession.prototype, "recreateEmptyTable");

    // A recompute-shaped write: every file named, half of them unchanged.
    await db.replaceIdentifiersBulk(
      Array.from({ length: FILES }, (_, f) => ({ relPath: `src/f${f}.ts`, rows: rowsFor(f, 0) })),
    );
    await db.replaceIdentifiersBulk(
      Array.from({ length: FILES }, (_, f) => ({ relPath: `src/f${f}.ts`, rows: rowsFor(f, f % 2) })),
    );
    await db.removeFile("src/f0.ts");

    expect(deletes.length).toBeGreaterThan(0);
    expect(deletes.every((sql) => /\bWHERE rel_path (IN \(|= \?)/.test(sql))).toBe(true);
    expect(recreate).not.toHaveBeenCalledWith("cg_identifiers");
  });

  it("(c) repeated incremental rewrites of the same files leave stored row versions equal to live rows", async () => {
    for (let run = 0; run < RUNS; run++) {
      // Each run moves a third of the files (their identifiers changed) and
      // re-names the rest unchanged, as an incremental over a busy branch does.
      await db.replaceIdentifiersBulk(
        Array.from({ length: FILES }, (_, f) => ({
          relPath: `src/f${f}.ts`,
          rows: rowsFor(f, f % 3 === run % 3 ? run : 0),
        })),
      );
      await db.checkpoint();
    }

    const { stored, live } = await storedVsLive();
    expect(live).toBe(FILES * ROWS_PER_FILE);
    expect(stored, "dead row versions kept — did cg_identifiers gain an index? (bd tea-rags-mcp-dvzdm)").toBe(live);
  });
});
