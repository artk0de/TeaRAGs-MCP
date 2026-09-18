/**
 * bd tea-rags-mcp-tslvq — the deferred chunk pass REPLACES the symbol → chunk
 * join for every file it names.
 *
 * The NULL guarantee used to come from the writer above it: `upsertSymbols`
 * deleted and re-inserted a file's rows, so every re-walked symbol arrived with
 * `chunk_id` NULL and the join pass only ever had to fill values in. That write
 * is now a row diff — an unchanged symbol is not rewritten at all, so it keeps
 * whatever chunk_id it had. The guarantee therefore moves to the pass that owns
 * the column: naming a file clears its symbols' chunk_id first, then applies the
 * fresh mapping. A symbol that lost its covering chunk between runs ends NULL,
 * exactly as before — just decided at the point where the answer is known.
 *
 * Both halves are set-based and live in one transaction: nothing observes the
 * intermediate all-NULL state, and no reader ever sees a stale id.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import type { RelPath, SymbolId } from "../../../../src/core/contracts/types/codegraph.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/domains/maintenance/migration/database/runner.js";

describe("updateSymbolChunkIdsBulk — replace semantics per named file", () => {
  let dir: string;
  let client: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-chunkid-replace-"));
    client = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await client.init();
    await runMigrations(client, DATABASE_MIGRATIONS);
  });

  afterEach(async () => {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function seedFile(rel: string, symbolIds: readonly string[]): Promise<void> {
    await client.upsertSymbolsBulk([
      {
        relPath: rel,
        definitions: symbolIds.map((symbolId) => ({
          symbolId,
          fqName: symbolId,
          shortName: symbolId,
          relPath: rel,
          scope: [],
        })),
      },
    ]);
  }

  async function chunkIdsOf(rel: string): Promise<Record<string, string | null>> {
    const rows = await client.queryAll<{ symbol_id: string; chunk_id: string | null }>(
      `SELECT symbol_id, chunk_id FROM cg_symbols WHERE rel_path = '${rel}' ORDER BY symbol_id`,
    );
    return Object.fromEntries(rows.map((r) => [r.symbol_id, r.chunk_id]));
  }

  it("clears the stale chunk_id of a symbol the fresh mapping no longer covers", async () => {
    await seedFile("src/a.ts", ["A#idle", "A#run"]);
    await client.updateSymbolChunkIdsBulk([
      {
        relPath: "src/a.ts",
        chunkIds: new Map([
          ["A#run", "chunk_run_v1"],
          ["A#idle", "chunk_idle_v1"],
        ]),
      },
    ]);

    // The re-walk emits the same symbols, so the row diff leaves both rows —
    // and their chunk_ids — physically untouched.
    await seedFile("src/a.ts", ["A#idle", "A#run"]);
    expect(await chunkIdsOf("src/a.ts")).toEqual({ "A#idle": "chunk_idle_v1", "A#run": "chunk_run_v1" });

    // Re-chunking moved A#idle out of every chunk's line range: this run's
    // mapping covers A#run only.
    await client.updateSymbolChunkIdsBulk([{ relPath: "src/a.ts", chunkIds: new Map([["A#run", "chunk_run_v2"]]) }]);

    expect(await chunkIdsOf("src/a.ts")).toEqual({ "A#idle": null, "A#run": "chunk_run_v2" });
  });

  it("clears a named file whose fresh mapping is empty", async () => {
    await seedFile("src/a.ts", ["A#run"]);
    await client.updateSymbolChunkIdsBulk([{ relPath: "src/a.ts", chunkIds: new Map([["A#run", "chunk_run"]]) }]);

    await client.updateSymbolChunkIdsBulk([{ relPath: "src/a.ts", chunkIds: new Map() }]);

    expect(await chunkIdsOf("src/a.ts")).toEqual({ "A#run": null });
  });

  it("leaves a file the entry list never named completely alone", async () => {
    await seedFile("src/a.ts", ["A#run"]);
    await seedFile("src/b.ts", ["B#go"]);
    await client.updateSymbolChunkIdsBulk([
      { relPath: "src/a.ts", chunkIds: new Map([["A#run", "chunk_a"]]) },
      { relPath: "src/b.ts", chunkIds: new Map([["B#go", "chunk_b"]]) },
    ]);

    // An incremental pass re-derives only src/a.ts. src/b.ts was not re-chunked,
    // so its join is still valid and must survive.
    await client.updateSymbolChunkIdsBulk([{ relPath: "src/a.ts", chunkIds: new Map([["A#run", "chunk_a_v2"]]) }]);

    expect(await chunkIdsOf("src/a.ts")).toEqual({ "A#run": "chunk_a_v2" });
    expect(await chunkIdsOf("src/b.ts")).toEqual({ "B#go": "chunk_b" });
  });

  it("applies the replace across more files than fit one statement", async () => {
    const stale: { relPath: RelPath; chunkIds: Map<SymbolId, string> }[] = [];
    const fresh: { relPath: RelPath; chunkIds: Map<SymbolId, string> }[] = [];
    for (let f = 0; f < 250; f++) {
      const rel = `src/f${f}.ts`;
      await seedFile(rel, [`F${f}#a`, `F${f}#b`]);
      stale.push({
        relPath: rel,
        chunkIds: new Map([
          [`F${f}#a`, `chunk_${f}_a`],
          [`F${f}#b`, `chunk_${f}_b`],
        ]),
      });
      // The second pass drops every `#b` symbol's chunk.
      fresh.push({ relPath: rel, chunkIds: new Map([[`F${f}#a`, `chunk_${f}_a`]]) });
    }
    await client.updateSymbolChunkIdsBulk(stale);
    expect((await client.queryAll<{ n: number }>(SQL_JOINED))[0].n).toBe(500);

    await client.updateSymbolChunkIdsBulk(fresh);

    expect((await client.queryAll<{ n: number }>(SQL_JOINED))[0].n).toBe(250);
    expect(await client.findSymbolChunk("F249#b")).toBeNull();
    expect(await client.findSymbolChunk("F249#a")).toEqual({
      relPath: "src/f249.ts",
      chunkId: "chunk_249_a",
    });
  });
});

const SQL_JOINED = "SELECT count(*)::INTEGER AS n FROM cg_symbols WHERE chunk_id IS NOT NULL";
