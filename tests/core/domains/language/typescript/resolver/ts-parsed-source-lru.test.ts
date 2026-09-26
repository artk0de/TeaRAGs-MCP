/**
 * The shared parse cache's byte bound (bd tea-rags-mcp-vtuu4).
 *
 * Batches share parses through one compiler host, and a bound `ts.SourceFile`
 * is reusable across Programs — the binder skips a file whose `locals` is set,
 * so a hit comes back already bound. What the cache must NOT do is keep every
 * parse the run ever made: heap scales with retained source TEXT (≈ 30 MB per
 * MB), so the bound is in bytes, least recently used first, with the prelude
 * pinned because every batch reads it.
 */

import { describe, expect, it } from "vitest";

import { TSParsedSourceLru } from "../../../../../../src/core/domains/language/typescript/resolver/ts-parsed-source-lru.js";

describe("TSParsedSourceLru (bd tea-rags-mcp-vtuu4)", () => {
  it("evicts parses least-recently-used by source text bytes", () => {
    const lru = new TSParsedSourceLru(100);
    lru.remember("a", 40);
    lru.remember("b", 40);
    lru.touch("a");
    lru.remember("c", 40);

    expect(lru.overflow()).toEqual(["b"]);
    expect(lru.textBytes).toBe(80);
  });

  it("never evicts a pinned parse however far the budget overflows", () => {
    const lru = new TSParsedSourceLru(10);
    lru.pin(["prelude"]);
    lru.remember("prelude", 500);
    lru.remember("a", 5);
    lru.remember("b", 20);

    expect(lru.overflow()).toEqual(["a", "b"]);
    expect(lru.textBytes).toBe(0);
    expect(lru.isPinned("prelude")).toBe(true);
  });

  it("stops evicting once the remaining text fits", () => {
    const lru = new TSParsedSourceLru(50);
    lru.remember("a", 30);
    lru.remember("b", 30);
    lru.remember("c", 10);

    expect(lru.overflow()).toEqual(["a"]);
    expect(lru.textBytes).toBe(40);
  });

  it("forgets a parse dropped for another reason without evicting anything else", () => {
    const lru = new TSParsedSourceLru(50);
    lru.remember("a", 30);
    lru.remember("b", 30);
    lru.forget("a");

    expect(lru.textBytes).toBe(30);
    expect(lru.overflow()).toEqual([]);
  });

  it("clears to empty and unpins on clear", () => {
    const lru = new TSParsedSourceLru(50);
    lru.pin(["p"]);
    lru.remember("a", 30);

    lru.clear();

    expect(lru.textBytes).toBe(0);
    expect(lru.isPinned("p")).toBe(false);
  });

  it("drops everything unpinned on evictAll, keeping the pins", () => {
    const lru = new TSParsedSourceLru(1000);
    lru.pin(["p"]);
    lru.remember("p", 10);
    lru.remember("a", 30);
    lru.remember("b", 30);

    expect(lru.evictAll()).toEqual(["a", "b"]);
    expect(lru.textBytes).toBe(0);
    expect(lru.isPinned("p")).toBe(true);
  });
});
