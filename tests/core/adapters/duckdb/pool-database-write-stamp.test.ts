/**
 * `GraphDbClientPool#databaseWriteStamp` (bd tea-rags-mcp-nehn5): the stamp a
 * long-lived process keys its cached reads of one codegraph database by. It
 * must move on EVERY committed write — an incremental index, a recompute that
 * leaves the indexed commit alone, a checkpoint folding the WAL in — and stay
 * put while nothing writes, or a cache keyed by it serves rows the database no
 * longer holds.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fixturePhysicalCollectionName } from "../../__helpers__/collection-identity.js";
import type { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import { GraphDbClientPool } from "../../../../src/core/adapters/duckdb/pool.js";
import type { GraphDbClient } from "../../../../src/core/contracts/types/codegraph.js";
import { createDatabaseMigrationApplier } from "../../../../src/core/domains/maintenance/migration/database/index.js";
import { InMemoryGlobalSymbolTable } from "../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const TARGET = fixturePhysicalCollectionName("stamped");

let tmp: string;
let pool: GraphDbClientPool;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "pool-write-stamp-"));
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

async function writeFile(graphDb: GraphDbClient, relPath: string): Promise<void> {
  await graphDb.upsertFile({ relPath, language: "typescript" }, { fileEdges: [], methodEdges: [] });
}

describe("GraphDbClientPool#databaseWriteStamp", () => {
  it("is absent for a collection with no database", () => {
    expect(pool.databaseWriteStamp(TARGET)).toBeUndefined();
  });

  it("holds while nothing writes", async () => {
    const { graphDb } = await pool.acquire(TARGET);
    await writeFile(graphDb, "a.ts");
    const before = pool.databaseWriteStamp(TARGET);

    await graphDb.listFileContentHashes();

    expect(pool.databaseWriteStamp(TARGET)).toBe(before);
  });

  it("moves on every committed write, a checkpoint included", async () => {
    const { graphDb } = await pool.acquire(TARGET);
    await writeFile(graphDb, "a.ts");
    const first = pool.databaseWriteStamp(TARGET);

    await writeFile(graphDb, "b.ts");
    const second = pool.databaseWriteStamp(TARGET);
    await (graphDb as DuckDbGraphClient).checkpoint();
    const third = pool.databaseWriteStamp(TARGET);

    expect(first).toBeDefined();
    expect(new Set([first, second, third]).size).toBe(3);
  });
});

describe("GraphDbClientPool#acquireReader — whole-graph reads held per write stamp (bd tea-rags-mcp-lnor0)", () => {
  async function readHashes(): Promise<readonly { relPath: string }[]> {
    const { graphDb } = await pool.acquireReader(TARGET);
    try {
      return await graphDb.listFileContentHashes();
    } finally {
      await graphDb.close();
    }
  }

  it("serves a later reader the read an earlier one made, until a write moves the stamp", async () => {
    const writer = await pool.acquire(TARGET);
    await writeFile(writer.graphDb, "a.ts");
    await pool.closeAll();

    const first = await readHashes();
    const second = await readHashes();
    expect(second).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);

    const again = await pool.acquire(TARGET);
    await writeFile(again.graphDb, "b.ts");
    await pool.closeAll();

    const afterWrite = await readHashes();
    expect(afterWrite).not.toBe(first);
    expect(afterWrite.map((row) => row.relPath).sort()).toEqual(["a.ts", "b.ts"]);
  });
});
