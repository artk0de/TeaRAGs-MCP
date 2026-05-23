import { describe, expect, it } from "vitest";

import type { CallContext } from "../../../../../../../../src/core/contracts/types/codegraph.js";
import { GoCallResolver } from "../../../../../../../../src/core/domains/trajectory/codegraph/symbols/resolvers/go/go-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

function ctx(
  callerFile: string,
  imports: { importText: string; startLine: number }[],
  table: InMemoryGlobalSymbolTable,
  localBindings?: Record<string, string>,
): CallContext {
  return { callerFile, callerScope: [], imports, symbolTable: table, localBindings };
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

  // bd tea-rags-mcp-e6xx — typed-receiver resolution via localBindings.
  // Inside `func (c *Context) Render() { c.JSON(...) }`, the receiver `c`
  // is locally bound to type `Context`. The resolver must lift `c.JSON`
  // to `Context#JSON` and resolve against the symbol table; otherwise
  // every Go method-call site stays unresolved (no edges, no callgraph).
  it("resolves `c.JSON(...)` to Context#JSON when localBindings binds c→Context (instance form)", () => {
    const r = new GoCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    t.upsertFile("context.go", [
      {
        symbolId: "Context#JSON",
        fqName: "Context#JSON",
        shortName: "JSON",
        relPath: "context.go",
        scope: [],
      },
    ]);
    const target = r.resolve(
      { callText: "c.JSON(200, obj)", receiver: "c", member: "JSON", startLine: 5 },
      ctx("context.go", [], t, { c: "Context" }),
    );
    expect(target?.targetSymbolId).toBe("Context#JSON");
    expect(target?.targetRelPath).toBe("context.go");
  });

  it("falls back to Type.member (static form) when instance form not present", () => {
    // Some Go projects emit class-level helpers via the static form
    // (`.`) — the resolver should accept either form when the localType
    // points at a type with that member as a static.
    const r = new GoCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    t.upsertFile("ctx.go", [
      {
        symbolId: "Context.helper",
        fqName: "Context.helper",
        shortName: "helper",
        relPath: "ctx.go",
        scope: [],
      },
    ]);
    const target = r.resolve(
      { callText: "c.helper()", receiver: "c", member: "helper", startLine: 1 },
      ctx("ctx.go", [], t, { c: "Context" }),
    );
    expect(target?.targetSymbolId).toBe("Context.helper");
  });

  it("drops edge when localBinding points at a Type that does NOT define the member (no global fallback)", () => {
    // Real-world parity with python-resolver step 0 — when the walker
    // knows the receiver's type but the type doesn't define the method
    // (e.g. inherited via embedding the resolver doesn't model yet),
    // dropping is safer than fabricating an edge via global short-name.
    const r = new GoCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    // Symbol exists under a DIFFERENT type, not Context. Global short-name
    // lookup would otherwise pick this up — must be suppressed.
    t.upsertFile("other.go", [
      {
        symbolId: "Other#unrelated",
        fqName: "Other#unrelated",
        shortName: "unrelated",
        relPath: "other.go",
        scope: [],
      },
    ]);
    const target = r.resolve(
      { callText: "c.unrelated()", receiver: "c", member: "unrelated", startLine: 1 },
      ctx("ctx.go", [], t, { c: "Context" }),
    );
    expect(target).toBeNull();
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
