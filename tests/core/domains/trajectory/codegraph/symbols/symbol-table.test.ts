import { beforeEach, describe, expect, it } from "vitest";

import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

describe("InMemoryGlobalSymbolTable", () => {
  let table: InMemoryGlobalSymbolTable;
  beforeEach(() => {
    table = new InMemoryGlobalSymbolTable();
  });

  it("returns empty arrays for unknown lookups", () => {
    expect(table.lookup("Foo.bar")).toEqual([]);
    expect(table.lookupByShortName("bar")).toEqual([]);
    expect(table.size()).toBe(0);
  });

  it("upserts symbols and resolves by fqName and short name", () => {
    table.upsertFile("src/foo.ts", [
      { symbolId: "Foo.bar", fqName: "Foo.bar", shortName: "bar", relPath: "src/foo.ts", scope: ["Foo"] },
      { symbolId: "Foo.baz", fqName: "Foo.baz", shortName: "baz", relPath: "src/foo.ts", scope: ["Foo"] },
    ]);
    expect(table.lookup("Foo.bar")).toEqual([
      { symbolId: "Foo.bar", fqName: "Foo.bar", shortName: "bar", relPath: "src/foo.ts", scope: ["Foo"] },
    ]);
    expect(table.lookupByShortName("baz").length).toBe(1);
    expect(table.size()).toBe(2);
  });

  it("removeFile drops all symbols owned by the file", () => {
    table.upsertFile("src/foo.ts", [
      { symbolId: "Foo.bar", fqName: "Foo.bar", shortName: "bar", relPath: "src/foo.ts", scope: ["Foo"] },
    ]);
    table.upsertFile("src/quux.ts", [
      { symbolId: "Quux.bar", fqName: "Quux.bar", shortName: "bar", relPath: "src/quux.ts", scope: ["Quux"] },
    ]);
    table.removeFile("src/foo.ts");
    expect(table.lookup("Foo.bar")).toEqual([]);
    expect(table.lookupByShortName("bar").map((d) => d.relPath)).toEqual(["src/quux.ts"]);
  });

  it("upsertFile is idempotent — re-upserting the same file replaces previous definitions", () => {
    table.upsertFile("src/foo.ts", [
      { symbolId: "Foo.bar", fqName: "Foo.bar", shortName: "bar", relPath: "src/foo.ts", scope: ["Foo"] },
    ]);
    table.upsertFile("src/foo.ts", [
      { symbolId: "Foo.baz", fqName: "Foo.baz", shortName: "baz", relPath: "src/foo.ts", scope: ["Foo"] },
    ]);
    expect(table.lookup("Foo.bar")).toEqual([]);
    expect(table.lookup("Foo.baz").length).toBe(1);
  });

  it("monkey-patched modules return multiple matches for the same fqName", () => {
    table.upsertFile("src/a.ts", [
      { symbolId: "M.f", fqName: "M.f", shortName: "f", relPath: "src/a.ts", scope: ["M"] },
    ]);
    table.upsertFile("src/b.ts", [
      { symbolId: "M.f", fqName: "M.f", shortName: "f", relPath: "src/b.ts", scope: ["M"] },
    ]);
    expect(
      table
        .lookup("M.f")
        .map((d) => d.relPath)
        .sort(),
    ).toEqual(["src/a.ts", "src/b.ts"]);
  });

  // Slice 2 / A4c — bulk hydrate from disk-backed storage on cold start.
  // Definitions arrive as a flat list (one row per symbol from the
  // listAllSymbols SELECT); hydrate must group them by relPath and seed
  // the same byFq/byShort/byFile indexes as upsertFile would.
  it("hydrate groups flat definition list by relPath and indexes them like upsertFile", () => {
    table.hydrate([
      { symbolId: "Foo.bar", fqName: "Foo.bar", shortName: "bar", relPath: "src/foo.ts", scope: ["Foo"] },
      { symbolId: "Foo.baz", fqName: "Foo.baz", shortName: "baz", relPath: "src/foo.ts", scope: ["Foo"] },
      { symbolId: "Quux.f", fqName: "Quux.f", shortName: "f", relPath: "src/quux.ts", scope: ["Quux"] },
    ]);
    expect(table.size()).toBe(3);
    expect(table.lookupByShortName("bar").map((d) => d.relPath)).toEqual(["src/foo.ts"]);
    expect(table.lookup("Quux.f").map((d) => d.relPath)).toEqual(["src/quux.ts"]);
    // Existing removeFile invariant still holds — hydrate is just a
    // grouped upsertFile, the identity chain is intact.
    table.removeFile("src/foo.ts");
    expect(table.lookupByShortName("bar")).toEqual([]);
    expect(table.size()).toBe(1);
  });

  it("hydrate is a no-op on empty input (no spurious file rows)", () => {
    table.hydrate([]);
    expect(table.size()).toBe(0);
  });

  it("size() reflects total symbol count across files", () => {
    expect(table.size()).toBe(0);
    table.upsertFile("src/a.ts", [
      { symbolId: "A.x", fqName: "A.x", shortName: "x", relPath: "src/a.ts", scope: ["A"] },
      { symbolId: "A.y", fqName: "A.y", shortName: "y", relPath: "src/a.ts", scope: ["A"] },
    ]);
    expect(table.size()).toBe(2);
    table.upsertFile("src/b.ts", [
      { symbolId: "B.z", fqName: "B.z", shortName: "z", relPath: "src/b.ts", scope: ["B"] },
    ]);
    expect(table.size()).toBe(3);
    table.removeFile("src/a.ts");
    expect(table.size()).toBe(1);
  });
});
