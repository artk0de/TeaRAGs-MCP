/**
 * `GraphDbClientPool#isFileReaderOpen` (bd tea-rags-mcp-xi2r9, D5): the pool
 * counts the READ_ONLY file readers it hands out per path, so the working-tree
 * graph cache never deletes a tree graph a reader of this process still holds
 * open. The count drops when the handle is closed — once, however often the
 * caller closes it.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import { GraphDbClientPool } from "../../../../src/core/adapters/duckdb/pool.js";
import { createDatabaseMigrationApplier } from "../../../../src/core/domains/maintenance/migration/database/index.js";
import { InMemoryGlobalSymbolTable } from "../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

let tmp: string;
let pool: GraphDbClientPool;
let file: string;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "pool-file-reader-"));
  pool = new GraphDbClientPool({
    rootDir: tmp,
    symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
    applyMigrations: createDatabaseMigrationApplier(),
  });
  file = join(tmp, "tree.duckdb");
  const writer = new DuckDbGraphClient({ path: file });
  await writer.init();
  await writer.close();
});

afterEach(async () => {
  await pool.closeAll();
  rmSync(tmp, { recursive: true, force: true });
});

describe("GraphDbClientPool#isFileReaderOpen", () => {
  it("is true while a file reader is open and false once every one is closed", async () => {
    expect(pool.isFileReaderOpen(file)).toBe(false);

    const first = await pool.acquireFileReader(file);
    const second = await pool.acquireFileReader(file);
    expect(pool.isFileReaderOpen(file)).toBe(true);

    await first.graphDb.close();
    await first.graphDb.close();
    expect(pool.isFileReaderOpen(file)).toBe(true);

    await second.graphDb.close();
    expect(pool.isFileReaderOpen(file)).toBe(false);
  });

  it("a reader that fails to open is not counted", async () => {
    const missing = join(tmp, "absent", "nope.duckdb");

    await expect(pool.acquireFileReader(missing)).rejects.toThrow();

    expect(pool.isFileReaderOpen(missing)).toBe(false);
  });
});
