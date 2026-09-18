/**
 * `updateSymbolChunkIdsBulk` — the batched form of the symbol → covering-chunk
 * join (bd tea-rags-mcp-6aytq).
 *
 * The per-file form issues one transaction per file and one single-row UPDATE
 * per symbol inside it. On the deferred chunk pass that is 10,478 transactions
 * carrying 44,087 UPDATEs, each one a daemon round-trip — measured as the whole
 * 14.0s `deferredChunk` step of the completion tail. The bulk form folds the
 * same rows into ONE transaction of chunked multi-row `UPDATE … FROM (VALUES …)`
 * statements.
 *
 * What must NOT change: which rows end up carrying which chunk_id. The join is
 * keyed by (rel_path, symbol_id), so a symbol with the same id in another file
 * is untouched, and a file no entry NAMES keeps its prior values.
 *
 * Within a named file the write is a replace, not a merge (bd
 * tea-rags-mcp-tslvq) — `symbol-chunk-id-replace.test.ts` owns that half.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import type { RelPath, SymbolId } from "../../../../src/core/contracts/types/codegraph.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/domains/maintenance/migration/database/runner.js";

describe("DuckDbGraphClient.updateSymbolChunkIdsBulk", () => {
  let dir: string;
  let client: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-chunkid-bulk-"));
    client = new DuckDbGraphClient({ path: join(dir, "graph.duckdb") });
    await client.init();
    await runMigrations(client, DATABASE_MIGRATIONS);
  });

  afterEach(async () => {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function seedFile(rel: string, symbolIds: string[]): Promise<void> {
    await client.upsertSymbols(
      rel,
      symbolIds.map((symbolId) => ({
        symbolId,
        fqName: symbolId,
        shortName: symbolId,
        relPath: rel,
        scope: [],
      })),
    );
  }

  it("writes every file's join in one call, keyed by (relPath, symbolId)", async () => {
    await seedFile("src/a.ts", ["A#run", "A#idle"]);
    await seedFile("src/b.ts", ["A#run", "B#go"]);

    await client.updateSymbolChunkIdsBulk([
      { relPath: "src/a.ts", chunkIds: new Map([["A#run", "chunk_a_run"]]) },
      { relPath: "src/b.ts", chunkIds: new Map([["B#go", "chunk_b_go"]]) },
    ]);

    const rows = await client.queryAll<{ rel_path: string; symbol_id: string; chunk_id: string | null }>(
      "SELECT rel_path, symbol_id, chunk_id FROM cg_symbols ORDER BY rel_path, symbol_id",
    );
    expect(rows).toEqual([
      { rel_path: "src/a.ts", symbol_id: "A#idle", chunk_id: null },
      { rel_path: "src/a.ts", symbol_id: "A#run", chunk_id: "chunk_a_run" },
      // Same symbol id in another file — the join is keyed by BOTH columns, so
      // src/a.ts's write must not leak here.
      { rel_path: "src/b.ts", symbol_id: "A#run", chunk_id: null },
      { rel_path: "src/b.ts", symbol_id: "B#go", chunk_id: "chunk_b_go" },
    ]);
  });

  it("is a no-op for an empty entry list and for entries carrying no joins", async () => {
    await seedFile("src/a.ts", ["A#run"]);

    await client.updateSymbolChunkIdsBulk([]);
    await client.updateSymbolChunkIdsBulk([{ relPath: "src/a.ts", chunkIds: new Map() }]);

    const rows = await client.queryAll<{ chunk_id: string | null }>("SELECT chunk_id FROM cg_symbols");
    expect(rows).toEqual([{ chunk_id: null }]);
  });

  it("lands identical rows to the per-file form across more files than fit one statement", async () => {
    // 250 files × 3 symbols = 750 join rows — past any single-statement chunk
    // bound, so the chunking itself is exercised.
    const entries: { relPath: RelPath; chunkIds: Map<SymbolId, string> }[] = [];
    for (let f = 0; f < 250; f++) {
      const rel = `src/f${f}.ts`;
      await seedFile(rel, [`F${f}#a`, `F${f}#b`, `F${f}#c`]);
      entries.push({
        relPath: rel,
        chunkIds: new Map([
          [`F${f}#a`, `chunk_${f}_a`],
          [`F${f}#c`, `chunk_${f}_c`],
        ]),
      });
    }

    await client.updateSymbolChunkIdsBulk(entries);

    const joined = await client.queryAll<{ n: number }>(
      "SELECT count(*)::INTEGER AS n FROM cg_symbols WHERE chunk_id IS NOT NULL",
    );
    expect(joined[0].n).toBe(500);
    expect(await client.findSymbolChunk("F249#c")).toEqual({
      relPath: "src/f249.ts",
      chunkId: "chunk_249_c",
    });
    // The symbol left out of every entry keeps its prior NULL.
    expect(await client.findSymbolChunk("F249#b")).toBeNull();
  });

  it("keeps the last write when one call carries the same symbol twice", async () => {
    await seedFile("src/a.ts", ["A#run"]);

    await client.updateSymbolChunkIdsBulk([
      { relPath: "src/a.ts", chunkIds: new Map([["A#run", "chunk_first"]]) },
      { relPath: "src/a.ts", chunkIds: new Map([["A#run", "chunk_last"]]) },
    ]);

    expect(await client.findSymbolChunk("A#run")).toEqual({
      relPath: "src/a.ts",
      chunkId: "chunk_last",
    });
  });
});
