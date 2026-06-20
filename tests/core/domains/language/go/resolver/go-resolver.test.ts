import { describe, expect, it } from "vitest";

import type { CallContext, LocalBinding } from "../../../../../../src/core/contracts/types/codegraph.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { GoCallResolver } from "../../../../../../src/core/domains/language/go/resolver/go-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

function ctx(
  callerFile: string,
  imports: { importText: string; startLine: number }[],
  table: InMemoryGlobalSymbolTable,
  localBindings?: Record<string, LocalBinding[]>,
): CallContext {
  return { callerFile, callerScope: [], imports, symbolTable: table, localBindings };
}

describe("GoCallResolver", () => {
  it("resolves `pkg.Func()` to a file whose path contains the import suffix", () => {
    const r = new GoCallResolver(new DefaultSymbolIdComposer());
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
    const r = new GoCallResolver(new DefaultSymbolIdComposer());
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
    const r = new GoCallResolver(new DefaultSymbolIdComposer());
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
    const r = new GoCallResolver(new DefaultSymbolIdComposer());
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
      ctx("context.go", [], t, { c: [{ line: 1, type: "Context" }] }),
    );
    expect(target?.targetSymbolId).toBe("Context#JSON");
    expect(target?.targetRelPath).toBe("context.go");
  });

  it("falls back to Type.member (static form) when instance form not present", () => {
    // Some Go projects emit class-level helpers via the static form
    // (`.`) — the resolver should accept either form when the localType
    // points at a type with that member as a static.
    const r = new GoCallResolver(new DefaultSymbolIdComposer());
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
      ctx("ctx.go", [], t, { c: [{ line: 1, type: "Context" }] }),
    );
    expect(target?.targetSymbolId).toBe("Context.helper");
  });

  it("drops edge when localBinding points at a Type that does NOT define the member (no global fallback)", () => {
    // Real-world parity with python-resolver step 0 — when the walker
    // knows the receiver's type but the type doesn't define the method
    // (e.g. inherited via embedding the resolver doesn't model yet),
    // dropping is safer than fabricating an edge via global short-name.
    const r = new GoCallResolver(new DefaultSymbolIdComposer());
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
      ctx("ctx.go", [], t, { c: [{ line: 1, type: "Context" }] }),
    );
    expect(target).toBeNull();
  });

  // bd tea-rags-mcp-6g9c — local-var-typed receivers. `engine.Use()` inside
  // `func Default()` where `var engine Engine` (or `engine := Engine{}`)
  // declares the type. None of the imports match the bare receiver
  // `engine`, so before this fix the m46z receiver-drop fired and the
  // LEGITIMATE `Engine#Use` / `Engine#With` edges were lost. With the
  // walker emitting `{ engine: "Engine" }` the resolver's step-0
  // `resolveByLocalType` resolves them.
  it("resolves `engine.Use()` to Engine#Use via local-var binding engine→Engine", () => {
    const r = new GoCallResolver(new DefaultSymbolIdComposer());
    const t = new InMemoryGlobalSymbolTable();
    t.upsertFile("gin.go", [
      { symbolId: "Engine#Use", fqName: "Engine#Use", shortName: "Use", relPath: "gin.go", scope: [] },
      { symbolId: "Engine#With", fqName: "Engine#With", shortName: "With", relPath: "gin.go", scope: [] },
    ]);
    const useTarget = r.resolve(
      { callText: "engine.Use(mw)", receiver: "engine", member: "Use", startLine: 4 },
      ctx("gin.go", [], t, { engine: [{ line: 1, type: "Engine" }] }),
    );
    expect(useTarget?.targetSymbolId).toBe("Engine#Use");
    const withTarget = r.resolve(
      { callText: "engine.With(mw)", receiver: "engine", member: "With", startLine: 5 },
      ctx("gin.go", [], t, { engine: [{ line: 1, type: "Engine" }] }),
    );
    expect(withTarget?.targetSymbolId).toBe("Engine#With");
  });

  it("resolves self-receiver `c.GetQuery()` to Context#GetQuery via receiver binding c→Context", () => {
    // Go has no `this`: inside `func (c *Context) Query()` an intra-method
    // call `c.GetQuery()` must resolve to `Context#GetQuery` through the
    // receiver binding the walker emits.
    const r = new GoCallResolver(new DefaultSymbolIdComposer());
    const t = new InMemoryGlobalSymbolTable();
    t.upsertFile("context.go", [
      {
        symbolId: "Context#GetQuery",
        fqName: "Context#GetQuery",
        shortName: "GetQuery",
        relPath: "context.go",
        scope: [],
      },
    ]);
    const target = r.resolve(
      { callText: "c.GetQuery(key)", receiver: "c", member: "GetQuery", startLine: 3 },
      ctx("context.go", [], t, { c: [{ line: 1, type: "Context" }] }),
    );
    expect(target?.targetSymbolId).toBe("Context#GetQuery");
  });

  it("drops the edge when receiver does NOT match any import (no global short-name fallback)", () => {
    // Real-world case (gin): inside `(c *Context) initQueryCache()` the
    // expression `c.Request.URL.Query()` has receiver "c.Request.URL".
    // None of the imports match this receiver chain. The old behaviour
    // fell back to a global short-name lookup of "Query" and matched the
    // unique receiver-qualified `Context#Query` symbol, fabricating a
    // false-positive cycle. The resolver must drop the edge instead.
    const r = new GoCallResolver(new DefaultSymbolIdComposer());
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

  // bd tea-rags-mcp-6g9c (follow-up) — function-return-type binding. Real gin
  // `func Default() *Engine` does `engine := New(); engine.Use(...)`. The
  // walker emits localCallBindings `{ engine: "New" }` (var → called func) and
  // file-level functionReturnTypes `{ New: "Engine" }` (func → declared return
  // type, merged run-global so it's available cross-file). The resolver pairs
  // them: engine → New → Engine, then resolveByLocalType pins
  // `engine.Use()` → Engine#Use. Without this, no import matches the bare
  // receiver `engine`, the m46z drop fires, and the LEGITIMATE Engine#Use /
  // Engine#With edges from gin's Default() are lost. SAFE: declared return
  // types are static, and binding happens ONLY when the return type exists as
  // a concrete struct/type symbol in the table.
  describe("function-return-type binding (localCallBindings + functionReturnTypes)", () => {
    function ctxReturn(
      callerFile: string,
      table: InMemoryGlobalSymbolTable,
      localCallBindings: Record<string, string>,
      functionReturnTypes: Record<string, string>,
    ): CallContext {
      return { callerFile, callerScope: [], imports: [], symbolTable: table, localCallBindings, functionReturnTypes };
    }

    it("resolves `engine.Use()` / `engine.With()` to Engine#Use / Engine#With via engine→New→Engine", () => {
      const r = new GoCallResolver(new DefaultSymbolIdComposer());
      const t = new InMemoryGlobalSymbolTable();
      t.upsertFile("gin.go", [
        // The struct type symbol — its presence is the safety gate.
        { symbolId: "Engine", fqName: "Engine", shortName: "Engine", relPath: "gin.go", scope: [] },
        { symbolId: "Engine#Use", fqName: "Engine#Use", shortName: "Use", relPath: "gin.go", scope: [] },
        { symbolId: "Engine#With", fqName: "Engine#With", shortName: "With", relPath: "gin.go", scope: [] },
        // `New` is declared in a different file — exercises the cross-file
        // run-global functionReturnTypes map.
        { symbolId: "New", fqName: "New", shortName: "New", relPath: "engine.go", scope: [] },
      ]);
      const useTarget = r.resolve(
        { callText: "engine.Use(mw)", receiver: "engine", member: "Use", startLine: 4 },
        ctxReturn("gin.go", t, { engine: "New" }, { New: "Engine" }),
      );
      expect(useTarget?.targetSymbolId).toBe("Engine#Use");
      const withTarget = r.resolve(
        { callText: "engine.With(mw)", receiver: "engine", member: "With", startLine: 5 },
        ctxReturn("gin.go", t, { engine: "New" }, { New: "Engine" }),
      );
      expect(withTarget?.targetSymbolId).toBe("Engine#With");
    });

    it("localBindings (direct type) wins over localCallBindings when both name the receiver", () => {
      // Defensive precedence: a directly-known type should never be overridden
      // by a return-type indirection for the same var.
      const r = new GoCallResolver(new DefaultSymbolIdComposer());
      const t = new InMemoryGlobalSymbolTable();
      t.upsertFile("gin.go", [
        { symbolId: "Engine", fqName: "Engine", shortName: "Engine", relPath: "gin.go", scope: [] },
        { symbolId: "Engine#Use", fqName: "Engine#Use", shortName: "Use", relPath: "gin.go", scope: [] },
      ]);
      const target = r.resolve(
        { callText: "engine.Use()", receiver: "engine", member: "Use", startLine: 4 },
        {
          callerFile: "gin.go",
          callerScope: [],
          imports: [],
          symbolTable: t,
          localBindings: { engine: [{ line: 1, type: "Engine" }] },
          localCallBindings: { engine: "Bogus" },
          functionReturnTypes: { Bogus: "Nonexistent" },
        },
      );
      expect(target?.targetSymbolId).toBe("Engine#Use");
    });

    it("NEGATIVE: drops the edge when the return type is unknown / not a concrete type symbol", () => {
      // `x := Unknown()` where Unknown's return type is an interface / external
      // type that is NOT a struct symbol in the table. Binding it would
      // fabricate an edge — the resolver must drop instead. Here `Handler` is
      // an interface that has NO type symbol, only a method symbol elsewhere.
      const r = new GoCallResolver(new DefaultSymbolIdComposer());
      const t = new InMemoryGlobalSymbolTable();
      t.upsertFile("other.go", [
        // A method named ServeHTTP exists on some unrelated type; global
        // short-name would otherwise fabricate an edge.
        {
          symbolId: "Server#ServeHTTP",
          fqName: "Server#ServeHTTP",
          shortName: "ServeHTTP",
          relPath: "other.go",
          scope: [],
        },
      ]);
      const target = r.resolve(
        { callText: "x.ServeHTTP()", receiver: "x", member: "ServeHTTP", startLine: 2 },
        ctxReturn("main.go", t, { x: "Unknown" }, { Unknown: "Handler" }),
      );
      expect(target).toBeNull();
    });

    it("NEGATIVE: drops when the called func has no recorded return type", () => {
      const r = new GoCallResolver(new DefaultSymbolIdComposer());
      const t = new InMemoryGlobalSymbolTable();
      t.upsertFile("gin.go", [
        { symbolId: "Engine", fqName: "Engine", shortName: "Engine", relPath: "gin.go", scope: [] },
        { symbolId: "Engine#Use", fqName: "Engine#Use", shortName: "Use", relPath: "gin.go", scope: [] },
      ]);
      const target = r.resolve(
        { callText: "engine.Use()", receiver: "engine", member: "Use", startLine: 4 },
        ctxReturn("gin.go", t, { engine: "Mystery" }, {}),
      );
      expect(target).toBeNull();
    });

    it("NEGATIVE: binds the type but drops when the type does NOT define the member", () => {
      // engine→New→Engine resolves the TYPE, but Engine has no `Frobnicate`
      // method. Mirrors the m46z drop — no global short-name fallback.
      const r = new GoCallResolver(new DefaultSymbolIdComposer());
      const t = new InMemoryGlobalSymbolTable();
      t.upsertFile("gin.go", [
        { symbolId: "Engine", fqName: "Engine", shortName: "Engine", relPath: "gin.go", scope: [] },
        { symbolId: "Engine#Use", fqName: "Engine#Use", shortName: "Use", relPath: "gin.go", scope: [] },
      ]);
      // A Frobnicate on an unrelated type — global short-name would fabricate.
      t.upsertFile("other.go", [
        {
          symbolId: "Other#Frobnicate",
          fqName: "Other#Frobnicate",
          shortName: "Frobnicate",
          relPath: "other.go",
          scope: [],
        },
      ]);
      const target = r.resolve(
        { callText: "engine.Frobnicate()", receiver: "engine", member: "Frobnicate", startLine: 4 },
        ctxReturn("gin.go", t, { engine: "New" }, { New: "Engine" }),
      );
      expect(target).toBeNull();
    });
  });
});
