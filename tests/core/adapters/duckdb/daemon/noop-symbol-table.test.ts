import { describe, expect, it } from "vitest";

import { NoopGlobalSymbolTable } from "../../../../../src/core/adapters/duckdb/daemon/noop-symbol-table.js";
import type { SymbolDefinition } from "../../../../../src/core/contracts/types/codegraph.js";

const sampleDef: SymbolDefinition = {
  symbolId: "Foo#bar",
  fqName: "Foo.bar",
  shortName: "bar",
  relPath: "a.ts",
  scope: ["Foo"],
};

describe("NoopGlobalSymbolTable", () => {
  it("answers every lookup empty and reports size 0 — even after upsert/hydrate", () => {
    const table = new NoopGlobalSymbolTable();

    // Mutations are accepted but store nothing (the daemon never resolves).
    table.upsertFile("a.ts", [sampleDef]);
    table.hydrate([sampleDef]);

    expect(table.size()).toBe(0);
    expect(table.lookup("Foo.bar")).toEqual([]);
    expect(table.lookupByShortName("bar")).toEqual([]);

    // removeFile is a no-op and must not throw on an unknown path.
    expect(() => {
      table.removeFile("a.ts");
    }).not.toThrow();
    expect(table.size()).toBe(0);
  });
});

describe("NoopGlobalSymbolTable — file presence", () => {
  it("answers false for hasFile, because it stores nothing", () => {
    const table = new NoopGlobalSymbolTable();
    table.upsertFile("pkg/a.py", [
      {
        symbolId: "A",
        fqName: "A",
        shortName: "A",
        relPath: "pkg/a.py",
        scope: [],
      },
    ]);
    expect(table.hasFile("pkg/a.py")).toBe(false);
  });

  it("answers false for hasFilesUnder, including the whole-table query", () => {
    const table = new NoopGlobalSymbolTable();
    expect(table.hasFilesUnder("pkg")).toBe(false);
    expect(table.hasFilesUnder("")).toBe(false);
  });
});
