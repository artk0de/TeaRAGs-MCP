/**
 * bd tea-rags-mcp-tslvq — `cg_symbols` is written as a row DIFF, so a re-walk
 * that produces the definitions already on disk touches no row at all.
 *
 * This is the same invariant `file-graph-row-churn.test.ts` pins for the five
 * per-source-file edge tables (bd tea-rags-mcp-8l8d3), applied to the one table
 * that was left on DELETE+INSERT. Two things ride on it:
 *
 *  - The abort. DuckDB's commit path is not exception-safe for a transaction
 *    whose delete set and insert set share a key: `UndoBuffer::RevertCommit`
 *    re-appends the deleted rows into the indexes, hits the key the same
 *    transaction just inserted, and raises a duplicate-key `FatalException` from
 *    a native context — `libc++abi: terminating`, an abort() no JavaScript
 *    handler can catch. It killed the codegraph daemon nine times on 2026-08-17.
 *    `cg_symbols` produced that overlap on EVERY file it rewrote.
 *  - The cost. The INSERT floor is ~16k rows/s, so a taxdome Ruby recompute
 *    re-inserted its ~220k unchanged rows for nothing.
 *
 * `rowid` is the observation handle: DuckDB assigns a fresh one to an appended
 * row, so a row that keeps its rowid across a re-upsert provably was never
 * deleted and re-inserted — an assertion that does not depend on which
 * statements the writer chose to issue. The last case asserts the statements
 * too, because "no DELETE and no INSERT were issued" is the abort shape stated
 * directly.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import type { BulkSymbolUpsertEntry, SymbolDefinition } from "../../../../src/core/contracts/types/codegraph.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/domains/maintenance/migration/database/runner.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function freshDb(): Promise<DuckDbGraphClient> {
  const dir = mkdtempSync(join(tmpdir(), "cg-symbol-churn-"));
  const db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
  await db.init();
  await runMigrations(db, DATABASE_MIGRATIONS);
  cleanups.push(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return db;
}

/** `"<relPath> <symbolId>" -> rowid`, so churn is visible per persisted symbol. */
async function symbolRowIds(db: DuckDbGraphClient): Promise<Map<string, string>> {
  const rows = await db.queryAll<{ rowid: string | number; rel_path: string; symbol_id: string }>(
    "SELECT rowid, rel_path, symbol_id FROM cg_symbols",
  );
  return new Map(rows.map((r) => [`${r.rel_path} ${r.symbol_id}`, String(r.rowid)]));
}

function def(relPath: string, symbolId: string, fqName = symbolId): SymbolDefinition {
  return { relPath, symbolId, fqName, shortName: symbolId.split(/[#.]/).pop() ?? symbolId, scope: [] };
}

const entry = (relPath: string, symbolIds: readonly string[], fqPrefix = ""): BulkSymbolUpsertEntry => ({
  relPath,
  definitions: symbolIds.map((s) => def(relPath, s, `${fqPrefix}${s}`)),
});

/** The statements the writer actually issued — `run` carries every DML here. */
function recordStatements(db: DuckDbGraphClient): { sql: () => string[]; restore: () => void } {
  const { session } = db as unknown as { session: { run: (sql: string, params?: unknown[]) => Promise<void> } };
  const spy = vi.spyOn(session, "run");
  return {
    sql: () => spy.mock.calls.map((c) => c[0]),
    restore: () => {
      spy.mockRestore();
    },
  };
}

describe("cg_symbols writer — no delete-then-reinsert of the same primary key", () => {
  it("leaves unchanged symbol rows physically untouched across an identical re-upsert (upsertSymbolsBulk)", async () => {
    const db = await freshDb();
    const batch = [entry("app/a.rb", ["A", "A#one", "A#two"]), entry("app/b.rb", ["B", "B#go"])];
    await db.upsertSymbolsBulk(batch);
    const before = await symbolRowIds(db);
    expect(before.size).toBe(5);

    await db.upsertSymbolsBulk(batch);

    expect(await symbolRowIds(db)).toEqual(before);
  });

  it("leaves unchanged symbol rows physically untouched across an identical re-upsert (upsertSymbols)", async () => {
    const db = await freshDb();
    const defs = [def("app/a.rb", "A"), def("app/a.rb", "A#one")];
    await db.upsertSymbols("app/a.rb", defs);
    const before = await symbolRowIds(db);
    expect(before.size).toBe(2);

    await db.upsertSymbols("app/a.rb", defs);

    expect(await symbolRowIds(db)).toEqual(before);
  });

  it("touches only the symbols that actually changed", async () => {
    const db = await freshDb();
    await db.upsertSymbolsBulk([entry("app/a.rb", ["A#keep", "A#gone"])]);
    const before = await symbolRowIds(db);

    // `A#gone` dropped from the walk, `A#new` appeared, `A#keep` unchanged.
    await db.upsertSymbolsBulk([entry("app/a.rb", ["A#keep", "A#new"])]);

    const after = await symbolRowIds(db);
    expect([...after.keys()].sort()).toEqual(["app/a.rb A#keep", "app/a.rb A#new"]);
    expect(after.get("app/a.rb A#keep")).toBe(before.get("app/a.rb A#keep"));
  });

  it("still refreshes a changed non-key column of a surviving symbol", async () => {
    const db = await freshDb();
    await db.upsertSymbolsBulk([entry("app/a.rb", ["A#one"], "Old::")]);
    await db.upsertSymbolsBulk([entry("app/a.rb", ["A#one"], "New::")]);

    const rows = await db.queryAll<{ fq_name: string }>(
      "SELECT fq_name FROM cg_symbols WHERE rel_path = 'app/a.rb' AND symbol_id = 'A#one'",
    );
    expect(rows).toEqual([{ fq_name: "New::A#one" }]);
  });

  it("preserves the chunk_id of a symbol the re-upsert did not change", async () => {
    const db = await freshDb();
    await db.upsertSymbolsBulk([entry("app/a.rb", ["A#one", "A#two"])]);
    await db.updateSymbolChunkIdsBulk([{ relPath: "app/a.rb", chunkIds: new Map([["A#one", "chunk_one"]]) }]);

    // A recompute re-walks the file and emits the very same definitions. The
    // diff must not reset the join the deferred chunk pass already wrote —
    // clearing it is now the deferred pass's own job.
    await db.upsertSymbolsBulk([entry("app/a.rb", ["A#one", "A#two"])]);

    const rows = await db.queryAll<{ symbol_id: string; chunk_id: string | null }>(
      "SELECT symbol_id, chunk_id FROM cg_symbols WHERE rel_path = 'app/a.rb' ORDER BY symbol_id",
    );
    expect(rows).toEqual([
      { symbol_id: "A#one", chunk_id: "chunk_one" },
      { symbol_id: "A#two", chunk_id: null },
    ]);
  });

  it("issues neither a DELETE nor an INSERT against cg_symbols when the walk is identical", async () => {
    const db = await freshDb();
    const batch = [entry("app/a.rb", ["A", "A#one"]), entry("app/b.rb", ["B#go"])];
    await db.upsertSymbolsBulk(batch);

    const recorded = recordStatements(db);
    try {
      await db.upsertSymbolsBulk(batch);
      const dml = recorded.sql();
      expect(dml.filter((s) => /^\s*DELETE\b/i.test(s))).toEqual([]);
      expect(dml.filter((s) => /^\s*INSERT\b/i.test(s))).toEqual([]);
      expect(dml.filter((s) => /^\s*UPDATE\b/i.test(s))).toEqual([]);
    } finally {
      recorded.restore();
    }
  });
});
