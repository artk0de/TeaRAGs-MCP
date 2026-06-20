import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import type { RelPath, SymbolId } from "../../../../src/core/contracts/types/codegraph.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/infra/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/infra/migration/database/runner.js";

describe("migration 007 — cg_symbols.chunk_id", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("adds a nullable chunk_id column and a symbol_id index after init", async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-chunkid-"));
    const client = new DuckDbGraphClient({ path: join(dir, "graph.duckdb") });
    await client.init();
    await runMigrations(client, DATABASE_MIGRATIONS);

    const cols = await client.queryAll<{
      column_name: string;
      is_nullable: string;
    }>("SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'cg_symbols'");
    const chunkId = cols.find((c) => c.column_name === "chunk_id");
    expect(chunkId).toBeDefined();
    expect(chunkId!.is_nullable).toBe("YES");

    const idx = await client.queryAll<{ index_name: string }>(
      "SELECT index_name FROM duckdb_indexes() WHERE table_name = 'cg_symbols'",
    );
    expect(idx.map((r) => r.index_name)).toContain("idx_cg_symbols_symbol");

    await client.close();
  });
});

describe("DuckDbGraphClient — chunk_id read/write", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips chunk_id: upsert symbols, backfill chunk_id, find by symbolId", async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-rw-"));
    const client = new DuckDbGraphClient({ path: join(dir, "graph.duckdb") });
    await client.init();
    await runMigrations(client, DATABASE_MIGRATIONS);

    const rel = "app/models/foo.rb" as RelPath;
    await client.upsertSymbols(rel, [
      {
        symbolId: "Foo" as SymbolId,
        fqName: "Foo",
        shortName: "Foo",
        relPath: rel,
        scope: [],
      },
      {
        symbolId: "Foo#bar" as SymbolId,
        fqName: "Foo#bar",
        shortName: "bar",
        relPath: rel,
        scope: ["Foo"],
      },
    ]);

    // Before backfill: no covering chunk → null.
    expect(await client.findSymbolChunk("Foo#bar" as SymbolId)).toBeNull();

    // Empty map is a no-op (early return, no transaction).
    await client.updateSymbolChunkIds(rel, new Map());

    await client.updateSymbolChunkIds(rel, new Map([["Foo#bar" as SymbolId, "chunk_abc123def456"]]));

    expect(await client.findSymbolChunk("Foo#bar" as SymbolId)).toEqual({
      relPath: rel,
      chunkId: "chunk_abc123def456",
    });
    // Symbol with no backfilled chunk_id stays null.
    expect(await client.findSymbolChunk("Foo" as SymbolId)).toBeNull();
    // Unknown symbol → null.
    expect(await client.findSymbolChunk("Nope#x" as SymbolId)).toBeNull();

    await client.close();
  });
});
