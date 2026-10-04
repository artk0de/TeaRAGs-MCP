/**
 * `GraphDbClientPool#exportSnapshot` in direct mode (bd tea-rags-mcp-xi2r9,
 * WTO-7): the snapshot is taken by whoever holds the file. With no client cached
 * in this process a READ_ONLY attach does it; with a cached read-write client
 * that client does it, pinned like any other collection op, and stays cached.
 * A collection without a database is refused — never created to be exported.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fixturePhysicalCollectionName } from "../../__helpers__/collection-identity.js";
import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import { CodegraphDatabaseMissingError } from "../../../../src/core/adapters/duckdb/errors.js";
import { GraphDbClientPool } from "../../../../src/core/adapters/duckdb/pool.js";
import { createDatabaseMigrationApplier } from "../../../../src/core/domains/maintenance/migration/database/index.js";
import { InMemoryGlobalSymbolTable } from "../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const NAME = fixturePhysicalCollectionName("code_xi2r9_snapshot_v1");
const NO_EDGES = { fileEdges: [], methodEdges: [] };

let tmp: string;
let pool: GraphDbClientPool;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "pool-snapshot-"));
  pool = new GraphDbClientPool({
    rootDir: tmp,
    symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
    applyMigrations: createDatabaseMigrationApplier(),
  });
});

afterEach(async () => {
  await pool.closeAll();
  rmSync(tmp, { recursive: true, force: true });
});

async function relPathsIn(dbPath: string): Promise<string[]> {
  const reader = new DuckDbGraphClient({ path: dbPath, accessMode: "READ_ONLY" });
  await reader.init();
  try {
    const rows = await reader.queryAll<{ rel_path: string }>("SELECT rel_path FROM cg_symbols_files ORDER BY rel_path");
    return rows.map((r) => r.rel_path);
  } finally {
    await reader.close();
  }
}

describe("GraphDbClientPool#exportSnapshot (direct mode)", () => {
  it("exports through a READ_ONLY attach when no client is cached", async () => {
    const { graphDb } = await pool.acquire(NAME);
    await graphDb.upsertFile({ relPath: "a.ts", language: "typescript" }, NO_EDGES);
    await graphDb.upsertFile({ relPath: "b.ts", language: "typescript" }, NO_EDGES);
    await pool.release(NAME);
    const target = join(tmp, "wt", "snapshot.duckdb");

    await pool.exportSnapshot(NAME, target);

    expect(await relPathsIn(target)).toEqual(["a.ts", "b.ts"]);
    // The export opened nothing it keeps.
    expect(pool.peek(NAME)).toBeUndefined();
  });

  it("exports through the cached read-write client when one is open, and keeps it cached", async () => {
    const handle = await pool.acquire(NAME);
    await handle.graphDb.upsertFile({ relPath: "live.ts", language: "typescript" }, NO_EDGES);
    const target = join(tmp, "wt", "snapshot.duckdb");

    await pool.exportSnapshot(NAME, target);

    expect(await relPathsIn(target)).toEqual(["live.ts"]);
    expect(pool.peek(NAME)).toBe(handle);
  });

  it("refuses a collection without a database and creates none", async () => {
    const target = join(tmp, "wt", "snapshot.duckdb");

    await expect(pool.exportSnapshot(NAME, target)).rejects.toBeInstanceOf(CodegraphDatabaseMissingError);

    expect(pool.hasDatabase(NAME)).toBe(false);
    expect(existsSync(target)).toBe(false);
  });
});
