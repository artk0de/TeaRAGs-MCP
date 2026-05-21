/**
 * Behavioral coverage for the test helper itself — the helper is exercised
 * by composition / facade tests but only via the `acquire` path. The
 * peek/release/closeAll/pathFor methods exist to satisfy the
 * `GraphDbClientPool` contract and must return predictable stub values so
 * a consumer can swap in the real pool without behavior shifts.
 */

import { describe, expect, it } from "vitest";

import type { GlobalSymbolTable, GraphDbClient } from "../../../src/core/contracts/types/codegraph.js";
import { createStubPool } from "./codegraph-pool.js";

function makeStubGraphDb(): GraphDbClient {
  return {} as GraphDbClient;
}

function makeStubSymbolTable(): GlobalSymbolTable {
  return {} as GlobalSymbolTable;
}

describe("createStubPool", () => {
  it("acquire and peek return the same handle, both carrying the injected graphDb + symbolTable", async () => {
    const graphDb = makeStubGraphDb();
    const symbolTable = makeStubSymbolTable();
    const pool = createStubPool(graphDb, symbolTable);

    const acquired = await pool.acquire("collection_one");
    const peeked = pool.peek("collection_two");

    expect(acquired.graphDb).toBe(graphDb);
    expect(acquired.symbolTable).toBe(symbolTable);
    // Same handle regardless of collectionName — mirrors legacy single-DB shape
    expect(peeked).toBe(acquired);
  });

  it("release resolves to true (no-op) and closeAll resolves without error", async () => {
    const pool = createStubPool(makeStubGraphDb(), makeStubSymbolTable());
    await expect(pool.release("collection_one")).resolves.toBe(true);
    await expect(pool.closeAll()).resolves.toBeUndefined();
  });

  it("pathFor returns a :memory:<name> sentinel matching the helper contract", () => {
    const pool = createStubPool(makeStubGraphDb(), makeStubSymbolTable());
    expect(pool.pathFor("code_abc")).toBe(":memory:code_abc");
    expect(pool.pathFor("code_xyz")).toBe(":memory:code_xyz");
  });
});
