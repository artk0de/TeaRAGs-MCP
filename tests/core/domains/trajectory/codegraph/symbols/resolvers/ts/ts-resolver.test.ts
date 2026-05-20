import { describe, expect, it } from "vitest";

import type { CallContext, CallRef } from "../../../../../../../../src/core/contracts/types/codegraph.js";
import { TSCallResolver } from "../../../../../../../../src/core/domains/trajectory/codegraph/symbols/resolvers/ts/ts-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

describe("TSCallResolver", () => {
  it("resolves Foo.bar() via the imports list", () => {
    const symbolTable = new InMemoryGlobalSymbolTable();
    symbolTable.upsertFile("src/foo.ts", [
      { symbolId: "Foo.bar", fqName: "Foo.bar", shortName: "bar", relPath: "src/foo.ts", scope: ["Foo"] },
    ]);
    const resolver = new TSCallResolver({ baseUrl: ".", paths: {} });
    const call: CallRef = { callText: "Foo.bar()", receiver: "Foo", member: "bar", startLine: 5 };
    const ctx: CallContext = {
      callerFile: "src/main.ts",
      callerScope: [],
      imports: [{ importText: "./foo", startLine: 1 }],
      symbolTable,
    };
    const result = resolver.resolve(call, ctx);
    expect(result).toEqual({ targetRelPath: "src/foo.ts", targetSymbolId: "Foo.bar" });
  });

  it("returns null when symbol is not in the table", () => {
    const resolver = new TSCallResolver({ baseUrl: ".", paths: {} });
    const result = resolver.resolve(
      { callText: "Zzz.gone()", receiver: "Zzz", member: "gone", startLine: 1 },
      {
        callerFile: "src/a.ts",
        callerScope: [],
        imports: [],
        symbolTable: new InMemoryGlobalSymbolTable(),
      },
    );
    expect(result).toBeNull();
  });

  it("falls back to short-name lookup when no import matches but symbol is unique", () => {
    const symbolTable = new InMemoryGlobalSymbolTable();
    symbolTable.upsertFile("src/util.ts", [
      { symbolId: "helper", fqName: "helper", shortName: "helper", relPath: "src/util.ts", scope: [] },
    ]);
    const resolver = new TSCallResolver({ baseUrl: ".", paths: {} });
    const result = resolver.resolve(
      { callText: "helper()", receiver: null, member: "helper", startLine: 1 },
      { callerFile: "src/main.ts", callerScope: [], imports: [], symbolTable },
    );
    expect(result).toEqual({ targetRelPath: "src/util.ts", targetSymbolId: "helper" });
  });

  it("returns file-only resolution when target file is known but the symbol isn't yet indexed", () => {
    const symbolTable = new InMemoryGlobalSymbolTable();
    const resolver = new TSCallResolver({ baseUrl: ".", paths: {} });
    const result = resolver.resolve(
      { callText: "Foo.lateBound()", receiver: "Foo", member: "lateBound", startLine: 1 },
      {
        callerFile: "src/main.ts",
        callerScope: [],
        imports: [{ importText: "./foo", startLine: 1 }],
        symbolTable,
      },
    );
    expect(result).toEqual({ targetRelPath: "src/foo.ts", targetSymbolId: null });
  });
});
