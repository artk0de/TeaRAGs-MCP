/**
 * `ReadOnlyGraphFileReaders` (bd tea-rags-mcp-xi2r9, split out of
 * `GraphDbClientPool` in 0qaht.38): counts the READ_ONLY handles it hands out
 * per path, drops the count once per handle however often it is closed, and
 * never counts an open that failed.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import { DuckDbOpenFailedError } from "../../../../src/core/adapters/duckdb/errors.js";
import { ReadOnlyGraphFileReaders } from "../../../../src/core/adapters/duckdb/read-only-graph-file-readers.js";
import { InMemoryGlobalSymbolTable } from "../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

let tmp: string;
let file: string;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "ro-file-readers-"));
  file = join(tmp, "tree.duckdb");
  const writer = new DuckDbGraphClient({ path: file });
  await writer.init();
  await writer.close();
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("ReadOnlyGraphFileReaders", () => {
  it("counts each open handle once and forgets it on its first close", async () => {
    const readers = new ReadOnlyGraphFileReaders(() => new InMemoryGlobalSymbolTable());
    const first = await readers.acquire(file);
    const second = await readers.acquire(file);
    expect(readers.isOpen(file)).toBe(true);
    await first.graphDb.close();
    await first.graphDb.close();
    expect(readers.isOpen(file)).toBe(true);
    await second.graphDb.close();
    expect(readers.isOpen(file)).toBe(false);
  });

  it("rejects an unopenable file with DuckDbOpenFailedError and does not count it", async () => {
    const readers = new ReadOnlyGraphFileReaders(() => new InMemoryGlobalSymbolTable());
    const garbage = join(tmp, "garbage.duckdb");
    writeFileSync(garbage, "not a database");
    await expect(readers.acquire(garbage)).rejects.toBeInstanceOf(DuckDbOpenFailedError);
    expect(readers.isOpen(garbage)).toBe(false);
  });
});
