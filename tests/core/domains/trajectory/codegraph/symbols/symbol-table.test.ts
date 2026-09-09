import { beforeEach, describe, expect, it } from "vitest";

import type { SymbolDefinition } from "../../../../../../src/core/contracts/types/codegraph.js";
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

const def = (shortName: string, relPath: string): SymbolDefinition => ({
  symbolId: `${relPath}:${shortName}`,
  fqName: shortName,
  shortName,
  relPath,
  scope: [],
});

describe("InMemoryGlobalSymbolTable#hasFile", () => {
  it("answers true for a file that contributed definitions", () => {
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("pkg/models.py", [def("User", "pkg/models.py")]);
    expect(table.hasFile("pkg/models.py")).toBe(true);
  });

  it("answers false for a path the table never saw", () => {
    expect(new InMemoryGlobalSymbolTable().hasFile("pkg/models.py")).toBe(false);
  });

  it("answers false for a file whose definitions were removed", () => {
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("pkg/models.py", [def("User", "pkg/models.py")]);
    table.removeFile("pkg/models.py");
    expect(table.hasFile("pkg/models.py")).toBe(false);
  });

  it("answers false for a file upserted with NO definitions", () => {
    // `upsertFile` returns early on an empty list, so the file never enters
    // `byFile`. "Present but contributing nothing" and "absent" are the same
    // answer to the only question the caller is asking.
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("pkg/empty.py", []);
    expect(table.hasFile("pkg/empty.py")).toBe(false);
  });
});

describe("InMemoryGlobalSymbolTable#hasFilesUnder", () => {
  it("answers true for every ancestor directory of a known file", () => {
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("netbox/dcim/models/devices.py", [def("Device", "netbox/dcim/models/devices.py")]);
    expect(table.hasFilesUnder("netbox")).toBe(true);
    expect(table.hasFilesUnder("netbox/dcim")).toBe(true);
    expect(table.hasFilesUnder("netbox/dcim/models")).toBe(true);
  });

  it("answers false for a sibling directory", () => {
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("netbox/dcim/models.py", [def("Device", "netbox/dcim/models.py")]);
    expect(table.hasFilesUnder("netbox/ipam")).toBe(false);
  });

  it("does not treat a path PREFIX as a directory", () => {
    // `netbox/dcim_extra` starts with `netbox/dcim`, and a naive
    // `startsWith` index would call the second a parent of the first.
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("netbox/dcim_extra/models.py", [def("X", "netbox/dcim_extra/models.py")]);
    expect(table.hasFilesUnder("netbox/dcim")).toBe(false);
  });

  it("treats the empty string as the whole table", () => {
    const table = new InMemoryGlobalSymbolTable();
    expect(table.hasFilesUnder("")).toBe(false);
    table.upsertFile("a.py", [def("A", "a.py")]);
    expect(table.hasFilesUnder("")).toBe(true);
  });

  it("ignores a trailing slash", () => {
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("pkg/a.py", [def("A", "pkg/a.py")]);
    expect(table.hasFilesUnder("pkg/")).toBe(true);
  });

  it("refcounts, so removing ONE of two files leaves the directory populated", () => {
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("pkg/a.py", [def("A", "pkg/a.py")]);
    table.upsertFile("pkg/b.py", [def("B", "pkg/b.py")]);
    table.removeFile("pkg/a.py");
    expect(table.hasFilesUnder("pkg")).toBe(true);
    table.removeFile("pkg/b.py");
    expect(table.hasFilesUnder("pkg")).toBe(false);
  });

  it("does not double-count a re-upsert of the same file", () => {
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("pkg/a.py", [def("A", "pkg/a.py")]);
    table.upsertFile("pkg/a.py", [def("A2", "pkg/a.py")]);
    table.removeFile("pkg/a.py");
    expect(table.hasFilesUnder("pkg")).toBe(false);
  });

  it("counts files hydrated in bulk", () => {
    const table = new InMemoryGlobalSymbolTable();
    table.hydrate([def("A", "pkg/a.py")]);
    expect(table.hasFilesUnder("pkg")).toBe(true);
    expect(table.hasFile("pkg/a.py")).toBe(true);
  });
});
