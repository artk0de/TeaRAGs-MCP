/**
 * A compaction replaces the collection's database file under the pooled client
 * (bd tea-rags-mcp-dvzdm), and the pool must not mistake that for the file
 * being replaced BEHIND the client (bd tea-rags-mcp-amh78). The identity the
 * pool checks is the file the client holds open now, so the same handle —
 * symbol table included — keeps serving every acquire, and nothing is closed.
 */

import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fixturePhysicalCollectionName } from "../../__helpers__/collection-identity.js";
import type { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import { GraphDbClientPool } from "../../../../src/core/adapters/duckdb/pool.js";
import { createDatabaseMigrationApplier } from "../../../../src/core/domains/maintenance/migration/database/index.js";
import { InMemoryGlobalSymbolTable } from "../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const NAME = fixturePhysicalCollectionName("code_dvzdm_v1");

let tmp: string;
let pool: GraphDbClientPool;
const closed = vi.fn();

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "pool-compaction-"));
  closed.mockReset();
  pool = new GraphDbClientPool({
    rootDir: tmp,
    symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
    applyMigrations: createDatabaseMigrationApplier(),
    onCollectionClientClosed: closed,
    compactionPolicy: { minFileBytes: 0, minStoredToLiveRatio: 2 },
  });
});

afterEach(async () => {
  await pool.closeAll();
  rmSync(tmp, { recursive: true, force: true });
});

describe("GraphDbClientPool across a storage compaction", () => {
  it("keeps serving the same handle and closes nothing", async () => {
    const handle = await pool.acquire(NAME);
    const graphDb = handle.graphDb as DuckDbGraphClient;
    for (let run = 0; run < 4; run++) {
      await graphDb.run("DELETE FROM cg_symbols_files");
      for (let f = 0; f < 25; f++) {
        await graphDb.run("INSERT INTO cg_symbols_files (rel_path, language) VALUES (?, 'typescript')", [`f${f}.ts`]);
      }
      await graphDb.checkpoint();
    }
    const inode = statSync(pool.pathFor(NAME)).ino;

    expect((await graphDb.compactStorage()).kind).toBe("compacted");

    expect(statSync(pool.pathFor(NAME)).ino).not.toBe(inode);
    expect(pool.peek(NAME)).toBe(handle);
    expect(await pool.acquire(NAME)).toBe(handle);
    expect(closed).not.toHaveBeenCalled();
    const [r] = await graphDb.queryAll<{ n: number | bigint }>("SELECT count(*) AS n FROM cg_symbols_files");
    expect(Number(r.n)).toBe(25);
  });
});
