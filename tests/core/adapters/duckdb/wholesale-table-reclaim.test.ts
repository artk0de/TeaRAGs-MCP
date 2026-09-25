/**
 * Wholesale-rewritten codegraph tables must not keep their dead row versions
 * (bd tea-rags-mcp-dvzdm).
 *
 * DuckDB 1.5.3 vacuums deleted rows at CHECKPOINT only for tables WITHOUT an
 * index, and every `cg_*` table carries a PRIMARY KEY. A `DELETE FROM <table>`
 * + re-INSERT therefore leaves the whole previous generation in the file:
 * `duckdb_tables().estimated_size` grows by the table's size on every run
 * while `count(*)` stays put (measured on taxdome: `cg_symbols_metrics` 58,209
 * live rows against 4,843,750 stored). Recreating the table instead hands its
 * row groups back to the free list, so the estimate equals the live count.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/domains/maintenance/migration/database/runner.js";

const RUNS = 4;

describe("wholesale codegraph table rewrites reclaim the previous generation", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-wholesale-reclaim-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
    await runMigrations(db, DATABASE_MIGRATIONS);
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function storedVsLive(table: string): Promise<{ stored: number; live: number }> {
    const [stored] = await db.queryAll<{ n: number | bigint }>(
      "SELECT estimated_size AS n FROM duckdb_tables() WHERE table_name = ?",
      [table],
    );
    const [live] = await db.queryAll<{ n: number | bigint }>(`SELECT count(*) AS n FROM ${table}`);
    return { stored: Number(stored?.n ?? -1), live: Number(live?.n ?? -1) };
  }

  async function constraintsOf(table: string): Promise<{ pk: string[]; indexes: string[] }> {
    const pk = await db.queryAll<{ t: string }>(
      "SELECT constraint_text AS t FROM duckdb_constraints() WHERE table_name = ? AND constraint_type = 'PRIMARY KEY'",
      [table],
    );
    const indexes = await db.queryAll<{ s: string }>(
      "SELECT sql AS s FROM duckdb_indexes() WHERE table_name = ? ORDER BY index_name",
      [table],
    );
    return { pk: pk.map((r) => r.t), indexes: indexes.map((r) => r.s) };
  }

  async function seedGraph(files: number): Promise<void> {
    for (let f = 0; f < files; f++) {
      const relPath = `src/f${f}.ts`;
      await db.run("INSERT INTO cg_symbols_files (rel_path, language) VALUES (?, 'typescript')", [relPath]);
      for (let s = 0; s < 5; s++) {
        await db.run(
          "INSERT INTO cg_symbols (rel_path, symbol_id, fq_name, short_name, scope_json, chunk_id) VALUES (?, ?, ?, ?, '{}', ?)",
          [relPath, `S${s}#m`, `S${s}#m`, "m", `c-${f}-${s}`],
        );
      }
    }
  }

  it("replacePageRanks leaves no dead rows in cg_symbols_metrics and keeps its key and indexes", async () => {
    const before = await constraintsOf("cg_symbols_metrics");
    const ranks = new Map<string, number>();
    for (let i = 0; i < 300; i++) ranks.set(`src/f${i}.ts|S#m`, 1 / (i + 1));

    for (let run = 0; run < RUNS; run++) {
      await db.replacePageRanks(ranks);
      await db.checkpoint();
    }

    expect(await storedVsLive("cg_symbols_metrics")).toEqual({ stored: 300, live: 300 });
    expect(await constraintsOf("cg_symbols_metrics")).toEqual(before);
    expect(await db.getPageRank("S#m", "src/f0.ts")).toBeCloseTo(1);
  });

  it("refreshSymbolSignalsPrev leaves no dead rows in either baseline table and keeps their keys", async () => {
    await seedGraph(40);
    const symbolBefore = await constraintsOf("cg_symbol_signals_prev");
    const fileBefore = await constraintsOf("cg_file_signals_prev");

    for (let run = 0; run < RUNS; run++) {
      await db.refreshSymbolSignalsPrev();
      await db.checkpoint();
    }

    expect(await storedVsLive("cg_symbol_signals_prev")).toEqual({ stored: 200, live: 200 });
    expect(await storedVsLive("cg_file_signals_prev")).toEqual({ stored: 40, live: 40 });
    expect(await constraintsOf("cg_symbol_signals_prev")).toEqual(symbolBefore);
    expect(await constraintsOf("cg_file_signals_prev")).toEqual(fileBefore);
    // The baseline still means what it meant: a fresh refresh diffs to nothing.
    expect(await db.diffSymbolSignals()).toEqual({ symbols: [], files: [] });
  });

  it("replaceTemporalCochange leaves no dead rows in any cg_temporal table and keeps their keys (bd tea-rags-mcp-x4rpp)", async () => {
    const tables = ["cg_temporal_files", "cg_temporal_edges_cochange", "cg_temporal_meta"];
    const before = await Promise.all(tables.map(constraintsOf));

    for (let run = 0; run < RUNS; run++) {
      // Every generation names a different file set, as a rebuild after deletions would.
      const files = Array.from({ length: 50 }, (_, i) => `src/g${run}/f${i}.ts`);
      await db.replaceTemporalCochange({
        meta: {
          head: `h${run}`,
          fingerprint: "fp",
          builtAt: run,
          windowSince: 0,
          commitCount: 10,
          bundleCount: 10,
          admittedBundleCount: 10,
          maxFilesPerBundle: 5,
          minSupport: 2,
          maxPartnersPerFile: 20,
          sessionGapMinutes: null,
        },
        files: files.map((relPath) => ({ relPath, bundleCount: 3, partnerCount: 1, lastChangedAt: run })),
        edges: files.slice(1).map((relPathB) => ({
          relPathA: files[0],
          relPathB,
          support: 2,
          confidenceAB: 0.5,
          confidenceBA: 1,
          lift: 2,
          lastCoChangeAt: run,
          sampleCommits: ["s1"],
        })),
      });
      await db.checkpoint();
    }

    expect(await storedVsLive("cg_temporal_files")).toEqual({ stored: 50, live: 50 });
    expect(await storedVsLive("cg_temporal_edges_cochange")).toEqual({ stored: 49, live: 49 });
    expect(await storedVsLive("cg_temporal_meta")).toEqual({ stored: 1, live: 1 });
    expect(await Promise.all(tables.map(constraintsOf))).toEqual(before);
    const graph = await db.readTemporalCochangeGraph();
    expect(graph.meta?.head).toBe(`h${RUNS - 1}`);
    expect(graph.edges.every((e) => e.relPathA.startsWith(`src/g${RUNS - 1}/`))).toBe(true);
  });

  it("a replacement that fails leaves the previous generation in place", async () => {
    await db.replacePageRanks(new Map([["src/a.ts|A#m", 0.5]]));

    // A bare key and an empty-file key both split to ("", "B#m"): the second
    // INSERT row violates the primary key and the transaction rolls back.
    const bad = new Map<string, number>([
      ["B#m", 0.1],
      ["|B#m", 0.2],
    ]);
    await expect(db.replacePageRanks(bad)).rejects.toThrow();

    expect(await db.getPageRank("A#m", "src/a.ts")).toBeCloseTo(0.5);
    expect((await constraintsOf("cg_symbols_metrics")).pk).toEqual(["PRIMARY KEY(rel_path, symbol_id)"]);
  });
});
