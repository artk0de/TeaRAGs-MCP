import { describe, expect, it } from "vitest";

import type { CallContext } from "../../../../../../../../src/core/contracts/types/codegraph.js";
import { GoCallResolver } from "../../../../../../../../src/core/domains/trajectory/codegraph/symbols/resolvers/go/go-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

function ctx(
  callerFile: string,
  imports: { importText: string; startLine: number }[],
  table: InMemoryGlobalSymbolTable,
): CallContext {
  return { callerFile, callerScope: [], imports, symbolTable: table };
}

describe("GoCallResolver", () => {
  it("resolves `pkg.Func()` to a file whose path contains the import suffix", () => {
    const r = new GoCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    t.upsertFile("foo/bar/x.go", [
      { symbolId: "Func", fqName: "Func", shortName: "Func", relPath: "foo/bar/x.go", scope: [] },
    ]);
    const target = r.resolve(
      { callText: "bar.Func()", receiver: "bar", member: "Func", startLine: 1 },
      ctx("main.go", [{ importText: "foo/bar", startLine: 1 }], t),
    );
    expect(target?.targetRelPath).toBe("foo/bar/x.go");
  });

  it("returns null when import does not match receiver and global lookup ambiguous", () => {
    const r = new GoCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    t.upsertFile("a.go", [{ symbolId: "Func", fqName: "Func", shortName: "Func", relPath: "a.go", scope: [] }]);
    t.upsertFile("b.go", [{ symbolId: "Func", fqName: "Func", shortName: "Func", relPath: "b.go", scope: [] }]);
    const target = r.resolve(
      { callText: "Func()", receiver: null, member: "Func", startLine: 1 },
      ctx("main.go", [], t),
    );
    expect(target).toBeNull();
  });

  it("falls back to global short-name when no receiver and unique", () => {
    const r = new GoCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    t.upsertFile("helpers.go", [
      { symbolId: "Util", fqName: "Util", shortName: "Util", relPath: "helpers.go", scope: [] },
    ]);
    const target = r.resolve(
      { callText: "Util()", receiver: null, member: "Util", startLine: 1 },
      ctx("main.go", [], t),
    );
    expect(target?.targetRelPath).toBe("helpers.go");
  });

  it("drops the edge when receiver does NOT match any import (no global short-name fallback)", () => {
    // Real-world case (gin): inside `(c *Context) initQueryCache()` the
    // expression `c.Request.URL.Query()` has receiver "c.Request.URL".
    // None of the imports match this receiver chain. The old behaviour
    // fell back to a global short-name lookup of "Query" and matched the
    // unique receiver-qualified `Context#Query` symbol, fabricating a
    // false-positive cycle. The resolver must drop the edge instead.
    const r = new GoCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    t.upsertFile("context.go", [
      {
        symbolId: "Context#Query",
        fqName: "Context#Query",
        shortName: "Query",
        relPath: "context.go",
        scope: [],
      },
    ]);
    const target = r.resolve(
      { callText: "c.Request.URL.Query()", receiver: "c.Request.URL", member: "Query", startLine: 1 },
      ctx("context.go", [], t),
    );
    expect(target).toBeNull();
  });
});
