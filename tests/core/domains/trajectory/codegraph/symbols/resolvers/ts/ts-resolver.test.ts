import { describe, expect, it } from "vitest";

import type { CallContext, CallRef } from "../../../../../../../../src/core/contracts/types/codegraph.js";
import { TSCallResolver } from "../../../../../../../../src/core/domains/trajectory/codegraph/symbols/resolvers/ts/ts-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

describe("TSCallResolver", () => {
  // Real-world bug from tea-rags-worktree self-test 2026-05-21: every
  // `this.X()` intra-class call was dropped — receiver "this" doesn't
  // match any import binding, and the short-name fallback returns more
  // than one candidate when the same method name exists in multiple
  // files. The fix routes `this.X()` / `super.X()` to an exact lookup
  // of `<enclosingClass>.X` constrained to the caller's own file.
  it("resolves this.X() against the enclosing class in the SAME file (intra-class call)", () => {
    const symbolTable = new InMemoryGlobalSymbolTable();
    symbolTable.upsertFile("src/store.ts", [
      { symbolId: "Store.read", fqName: "Store.read", shortName: "read", relPath: "src/store.ts", scope: ["Store"] },
      { symbolId: "Store.write", fqName: "Store.write", shortName: "write", relPath: "src/store.ts", scope: ["Store"] },
    ]);
    // Another file ALSO declares a `read` — global short-name lookup
    // would return 2 candidates and previously fall through to null.
    symbolTable.upsertFile("src/other.ts", [
      { symbolId: "Other.read", fqName: "Other.read", shortName: "read", relPath: "src/other.ts", scope: ["Other"] },
    ]);
    const resolver = new TSCallResolver({ baseUrl: ".", paths: {} });
    const result = resolver.resolve(
      { callText: "this.read(coll)", receiver: "this", member: "read", startLine: 7 },
      {
        callerFile: "src/store.ts",
        callerScope: ["Store"],
        imports: [],
        symbolTable,
      },
    );
    expect(result).toEqual({ targetRelPath: "src/store.ts", targetSymbolId: "Store.read" });
  });

  // bd tea-rags-mcp-4rgg — super.X() must route to the PARENT class's
  // method, NOT the enclosing class's own. Without classExtends in ctx
  // the resolver cannot determine the parent and returns null (avoids
  // the self-loop bug where super(...args) in `Child#constructor`
  // resolved to `Child#constructor` itself).
  it("super.X() returns null when classExtends has no entry for the enclosing class", () => {
    const symbolTable = new InMemoryGlobalSymbolTable();
    symbolTable.upsertFile("src/child.ts", [
      {
        symbolId: "Child#init",
        fqName: "Child#init",
        shortName: "init",
        relPath: "src/child.ts",
        scope: ["Child"],
      },
    ]);
    const resolver = new TSCallResolver({ baseUrl: ".", paths: {} });
    const result = resolver.resolve(
      { callText: "super.init()", receiver: "super", member: "init", startLine: 3 },
      {
        callerFile: "src/child.ts",
        callerScope: ["Child"],
        imports: [],
        symbolTable,
        // No classExtends — parent unknown, so the only safe result is
        // null. Self-looping back to Child#init (the OLD behaviour)
        // would emit a fake self-loop edge.
      },
    );
    expect(result).toBeNull();
  });

  it("does NOT misroute this.X() when callerScope is empty (top-level function context)", () => {
    const symbolTable = new InMemoryGlobalSymbolTable();
    symbolTable.upsertFile("src/store.ts", [
      { symbolId: "Store.read", fqName: "Store.read", shortName: "read", relPath: "src/store.ts", scope: ["Store"] },
    ]);
    const resolver = new TSCallResolver({ baseUrl: ".", paths: {} });
    const result = resolver.resolve(
      { callText: "this.read()", receiver: "this", member: "read", startLine: 1 },
      {
        callerFile: "src/other.ts",
        callerScope: [],
        imports: [],
        symbolTable,
      },
    );
    // No class scope -> intra-class branch skipped -> short-name
    // fallback finds 1 match -> resolves there. Not the bug case;
    // documents the non-class behaviour.
    expect(result).toEqual({ targetRelPath: "src/store.ts", targetSymbolId: "Store.read" });
  });

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

  // Cross-class via field access — `this.<field>.<method>()`. Walker
  // populates `classFieldTypes` from constructor parameter properties
  // and field declarations; resolver routes to `<typeName>#<method>`
  // (instance) with a `.<method>` (static) fallback.
  describe("cross-class via this.field.method() (classFieldTypes)", () => {
    it("resolves this.field.method() to <FieldType>#<method> when field type is declared", () => {
      const symbolTable = new InMemoryGlobalSymbolTable();
      symbolTable.upsertFile("src/store.ts", [
        {
          symbolId: "MarkerStore#write",
          fqName: "MarkerStore#write",
          shortName: "write",
          relPath: "src/store.ts",
          scope: ["MarkerStore"],
        },
      ]);
      symbolTable.upsertFile("src/coordinator.ts", [
        {
          symbolId: "Coordinator#start",
          fqName: "Coordinator#start",
          shortName: "start",
          relPath: "src/coordinator.ts",
          scope: ["Coordinator"],
        },
      ]);
      const resolver = new TSCallResolver({ baseUrl: ".", paths: {} });
      const ctx: CallContext = {
        callerFile: "src/coordinator.ts",
        callerScope: ["Coordinator"],
        imports: [{ importText: "./store", startLine: 1 }],
        symbolTable,
        classFieldTypes: { Coordinator: { markerStore: "MarkerStore" } },
      };
      const call: CallRef = {
        callText: "this.markerStore.write(coll)",
        receiver: "this.markerStore",
        member: "write",
        startLine: 10,
      };
      const result = resolver.resolve(call, ctx);
      expect(result).toEqual({ targetRelPath: "src/store.ts", targetSymbolId: "MarkerStore#write" });
    });

    it("falls back to <FieldType>.<method> when no instance form is found (static dispatch)", () => {
      const symbolTable = new InMemoryGlobalSymbolTable();
      symbolTable.upsertFile("src/util.ts", [
        {
          symbolId: "Util.parse",
          fqName: "Util.parse",
          shortName: "parse",
          relPath: "src/util.ts",
          scope: ["Util"],
        },
      ]);
      const resolver = new TSCallResolver({ baseUrl: ".", paths: {} });
      const ctx: CallContext = {
        callerFile: "src/main.ts",
        callerScope: ["Main"],
        imports: [],
        symbolTable,
        classFieldTypes: { Main: { util: "Util" } },
      };
      const call: CallRef = {
        callText: "this.util.parse(x)",
        receiver: "this.util",
        member: "parse",
        startLine: 5,
      };
      const result = resolver.resolve(call, ctx);
      expect(result).toEqual({ targetRelPath: "src/util.ts", targetSymbolId: "Util.parse" });
    });

    it("returns null and falls through when field type is NOT declared (not in classFieldTypes)", () => {
      const symbolTable = new InMemoryGlobalSymbolTable();
      symbolTable.upsertFile("src/store.ts", [
        {
          symbolId: "MarkerStore#write",
          fqName: "MarkerStore#write",
          shortName: "write",
          relPath: "src/store.ts",
          scope: ["MarkerStore"],
        },
      ]);
      const resolver = new TSCallResolver({ baseUrl: ".", paths: {} });
      const ctx: CallContext = {
        callerFile: "src/coordinator.ts",
        callerScope: ["Coordinator"],
        imports: [],
        symbolTable,
        // No classFieldTypes → field type unknown. Resolver should fall
        // through to short-name lookup. `write` is unique → resolves.
        classFieldTypes: undefined,
      };
      const call: CallRef = {
        callText: "this.markerStore.write(coll)",
        receiver: "this.markerStore",
        member: "write",
        startLine: 1,
      };
      const result = resolver.resolve(call, ctx);
      expect(result).toEqual({ targetRelPath: "src/store.ts", targetSymbolId: "MarkerStore#write" });
    });

    it("does NOT recurse on chained access (this.a.b.method() is out of scope)", () => {
      const symbolTable = new InMemoryGlobalSymbolTable();
      symbolTable.upsertFile("src/x.ts", [
        { symbolId: "X#go", fqName: "X#go", shortName: "go", relPath: "src/x.ts", scope: ["X"] },
      ]);
      const resolver = new TSCallResolver({ baseUrl: ".", paths: {} });
      const ctx: CallContext = {
        callerFile: "src/main.ts",
        callerScope: ["Main"],
        imports: [],
        symbolTable,
        classFieldTypes: { Main: { a: "A" } },
      };
      const call: CallRef = {
        callText: "this.a.b.go()",
        receiver: "this.a.b",
        member: "go",
        startLine: 1,
      };
      const result = resolver.resolve(call, ctx);
      // Chained — cross-class branch does NOT engage. Falls through to
      // short-name lookup; `go` is unique → resolves via fallback path.
      expect(result).toEqual({ targetRelPath: "src/x.ts", targetSymbolId: "X#go" });
    });

    it("survives NDJSON spill — classFieldTypes round-trips through JSON without losing structure", () => {
      // FileExtraction values may be spilled to NDJSON between walker-emit
      // and resolver-consume. Map does NOT survive JSON.stringify — it
      // serializes to {} and downstream `.get()` calls throw
      // `classFieldTypes?.get is not a function`. Contract must use a
      // JSON-safe shape.
      const symbolTable = new InMemoryGlobalSymbolTable();
      symbolTable.upsertFile("src/store.ts", [
        {
          symbolId: "MarkerStore#write",
          fqName: "MarkerStore#write",
          shortName: "write",
          relPath: "src/store.ts",
          scope: ["MarkerStore"],
        },
      ]);
      const resolver = new TSCallResolver({ baseUrl: ".", paths: {} });
      const original = { Coordinator: { markerStore: "MarkerStore" } };
      const afterSpill = JSON.parse(JSON.stringify(original)) as Record<string, Record<string, string>>;
      const ctx: CallContext = {
        callerFile: "src/coordinator.ts",
        callerScope: ["Coordinator"],
        imports: [{ importText: "./store", startLine: 1 }],
        symbolTable,
        classFieldTypes: afterSpill,
      };
      const call: CallRef = {
        callText: "this.markerStore.write(coll)",
        receiver: "this.markerStore",
        member: "write",
        startLine: 10,
      };
      const result = resolver.resolve(call, ctx);
      expect(result).toEqual({ targetRelPath: "src/store.ts", targetSymbolId: "MarkerStore#write" });
    });
  });

  describe("CODEGRAPH_AMBIGUOUS_RESOLVE_MODE", () => {
    function ambiguousTable(): InMemoryGlobalSymbolTable {
      const t = new InMemoryGlobalSymbolTable();
      t.upsertFile("src/a.ts", [
        { symbolId: "ClassA#save", fqName: "ClassA#save", shortName: "save", relPath: "src/a.ts", scope: ["ClassA"] },
      ]);
      t.upsertFile("src/b.ts", [
        { symbolId: "ClassB#save", fqName: "ClassB#save", shortName: "save", relPath: "src/b.ts", scope: ["ClassB"] },
      ]);
      return t;
    }

    it("strict mode (default) drops ambiguous global short-name", () => {
      const resolver = new TSCallResolver({ baseUrl: ".", paths: {} });
      const call: CallRef = { callText: "obj.save()", receiver: "obj", member: "save", startLine: 1 };
      const ctx: CallContext = {
        callerFile: "src/main.ts",
        callerScope: [],
        imports: [],
        symbolTable: ambiguousTable(),
      };
      // No import matched receiver `obj` → falls through to global short-name
      // lookup, two candidates → strict drops.
      expect(resolver.resolve(call, ctx)).toBeNull();
    });

    it("first mode picks arbitrary candidate (legacy)", () => {
      const resolver = new TSCallResolver({ baseUrl: ".", paths: {} }, "first");
      const call: CallRef = { callText: "obj.save()", receiver: "obj", member: "save", startLine: 1 };
      const ctx: CallContext = {
        callerFile: "src/main.ts",
        callerScope: [],
        imports: [],
        symbolTable: ambiguousTable(),
      };
      const result = resolver.resolve(call, ctx);
      expect(result).not.toBeNull();
      expect(result?.targetSymbolId).toBe("ClassA#save");
    });

    it("this.field.method() with two type matches: strict drops, first picks", () => {
      // `typeName` is "Foo"; symbol table has two `Foo#bar` entries
      // across files (e.g. via duplicate class declarations in monorepo).
      const t = new InMemoryGlobalSymbolTable();
      t.upsertFile("src/pkg1/foo.ts", [
        { symbolId: "Foo#bar", fqName: "Foo#bar", shortName: "bar", relPath: "src/pkg1/foo.ts", scope: ["Foo"] },
      ]);
      t.upsertFile("src/pkg2/foo.ts", [
        { symbolId: "Foo#bar", fqName: "Foo#bar", shortName: "bar", relPath: "src/pkg2/foo.ts", scope: ["Foo"] },
      ]);
      const call: CallRef = { callText: "this.helper.bar()", receiver: "this.helper", member: "bar", startLine: 1 };
      const ctx: CallContext = {
        callerFile: "src/main.ts",
        callerScope: ["Caller"],
        imports: [],
        symbolTable: t,
        classFieldTypes: { Caller: { helper: "Foo" } },
      };

      const strict = new TSCallResolver({ baseUrl: ".", paths: {} }).resolve(call, ctx);
      // Strict path: cross-class branch's instance candidates length=2 → drops;
      // static branch length=0; falls to global short-name (also length=2) →
      // strict drops there too → null.
      expect(strict).toBeNull();

      const first = new TSCallResolver({ baseUrl: ".", paths: {} }, "first").resolve(call, ctx);
      expect(first?.targetSymbolId).toBe("Foo#bar");
    });
  });

  // The symbolId convention (.claude/rules/symbolid-convention.md) requires
  // instance methods to use `#` between class and member. When the symbol
  // table holds the instance form `Store#read`, `this.read()` from inside
  // `Store` MUST resolve via the EXACT `Class#member` lookup (ts-resolver
  // line 50-52), NOT via the static `.` fallback nor the same-file
  // short-name fallback. This guards against silent regressions where the
  // resolver would degrade to short-name matching and misroute calls in
  // codebases that have two instance methods with the same short name in
  // different classes.
  it("resolves this.X() to <Class>#<X> when the symbol table holds the instance form", () => {
    const symbolTable = new InMemoryGlobalSymbolTable();
    symbolTable.upsertFile("src/store.ts", [
      {
        symbolId: "Store#read",
        fqName: "Store#read",
        shortName: "read",
        relPath: "src/store.ts",
        scope: ["Store"],
      },
    ]);
    // Same short-name in another file. If the resolver fell through to
    // the same-file short-name fallback OR the global short-name lookup,
    // it would either miss (wrong file) or hit ambiguity. The exact
    // `Store#read` lookup in the caller's file must win cleanly.
    symbolTable.upsertFile("src/other.ts", [
      {
        symbolId: "Other#read",
        fqName: "Other#read",
        shortName: "read",
        relPath: "src/other.ts",
        scope: ["Other"],
      },
    ]);
    const resolver = new TSCallResolver({ baseUrl: ".", paths: {} });
    const result = resolver.resolve(
      { callText: "this.read(coll)", receiver: "this", member: "read", startLine: 7 },
      {
        callerFile: "src/store.ts",
        callerScope: ["Store"],
        imports: [],
        symbolTable,
      },
    );
    expect(result).toEqual({ targetRelPath: "src/store.ts", targetSymbolId: "Store#read" });
  });

  // Same-file short-name fallback (ts-resolver line 61-62). Fires when
  // neither the instance `Class#member` nor the static `Class.member`
  // form is present in the symbol table, but a same-file definition with
  // a matching shortName exists. Covers the "class instance shadowed via
  // getter / decorator / mixin" comment in the resolver. The short-name
  // match must be CONSTRAINED to the caller's file so a same-shortName
  // symbol in another file doesn't misroute.
  it("falls back to same-file short-name lookup when neither Class#X nor Class.X is in the table", () => {
    const symbolTable = new InMemoryGlobalSymbolTable();
    // Caller file declares `read` but NOT under a Store-scoped fqName —
    // simulates a getter / decorator-generated symbol whose composed
    // name doesn't carry the class prefix.
    symbolTable.upsertFile("src/store.ts", [
      {
        symbolId: "read",
        fqName: "read",
        shortName: "read",
        relPath: "src/store.ts",
        scope: [],
      },
    ]);
    // Ambient `read` in another file. Without the SAME-FILE constraint
    // on the short-name fallback, this would create ambiguity and the
    // resolver would have to drop or guess.
    symbolTable.upsertFile("src/other.ts", [
      {
        symbolId: "Other#read",
        fqName: "Other#read",
        shortName: "read",
        relPath: "src/other.ts",
        scope: ["Other"],
      },
    ]);
    const resolver = new TSCallResolver({ baseUrl: ".", paths: {} });
    const result = resolver.resolve(
      { callText: "this.read(coll)", receiver: "this", member: "read", startLine: 7 },
      {
        callerFile: "src/store.ts",
        callerScope: ["Store"],
        imports: [],
        symbolTable,
      },
    );
    // Must pick the same-file `read`, not the cross-file `Other#read`.
    expect(result).toEqual({ targetRelPath: "src/store.ts", targetSymbolId: "read" });
  });

  // Interface-dispatch recall recovery (bd tea-rags-mcp-2qp6). When a
  // parameter typed as an interface is invoked (`resolver.resolve(...)`
  // where `resolver: CallResolver`), the walker has no type info on the
  // parameter — receiver is the bare identifier `resolver`. Global
  // short-name lookup returns N>1 candidates (one per implementing class).
  // Strict mode drops them all → 0 callers. Fix: narrow the ambiguous
  // global candidates by `ctx.imports` — the caller's import list is the
  // only signal available to bias toward the concrete implementer the
  // caller can reach. When exactly one candidate's file is reachable via
  // the imports, resolve to it; otherwise strict still drops.
  describe("imports-narrowed fallback for ambiguous global short-name", () => {
    it("picks the candidate whose file is reachable via ctx.imports when global short-name is ambiguous", () => {
      const symbolTable = new InMemoryGlobalSymbolTable();
      // Two implementations of `resolve` — both appear in the global
      // short-name lookup. The caller only imports the ruby resolver
      // file, so only `RubyCallResolver#resolve` is reachable.
      symbolTable.upsertFile("src/resolvers/ruby/ruby-resolver.ts", [
        {
          symbolId: "RubyCallResolver#resolve",
          fqName: "RubyCallResolver#resolve",
          shortName: "resolve",
          relPath: "src/resolvers/ruby/ruby-resolver.ts",
          scope: ["RubyCallResolver"],
        },
      ]);
      symbolTable.upsertFile("src/resolvers/python/python-resolver.ts", [
        {
          symbolId: "PythonCallResolver#resolve",
          fqName: "PythonCallResolver#resolve",
          shortName: "resolve",
          relPath: "src/resolvers/python/python-resolver.ts",
          scope: ["PythonCallResolver"],
        },
      ]);
      const resolver = new TSCallResolver({ baseUrl: ".", paths: {} });
      // Provider walks a file in src/provider/ that imports only the ruby resolver
      // and calls `resolver.resolve(call, ctx)` on a CallResolver-typed parameter.
      const result = resolver.resolve(
        { callText: "resolver.resolve(call, ctx)", receiver: "resolver", member: "resolve", startLine: 10 },
        {
          callerFile: "src/provider/provider.ts",
          callerScope: ["CodegraphProvider"],
          imports: [{ importText: "../resolvers/ruby/ruby-resolver", startLine: 1 }],
          symbolTable,
        },
      );
      expect(result).toEqual({
        targetRelPath: "src/resolvers/ruby/ruby-resolver.ts",
        targetSymbolId: "RubyCallResolver#resolve",
      });
    });

    it("still drops under strict mode when multiple candidates' files are all reachable via imports", () => {
      const symbolTable = new InMemoryGlobalSymbolTable();
      symbolTable.upsertFile("src/resolvers/ruby/ruby-resolver.ts", [
        {
          symbolId: "RubyCallResolver#resolve",
          fqName: "RubyCallResolver#resolve",
          shortName: "resolve",
          relPath: "src/resolvers/ruby/ruby-resolver.ts",
          scope: ["RubyCallResolver"],
        },
      ]);
      symbolTable.upsertFile("src/resolvers/python/python-resolver.ts", [
        {
          symbolId: "PythonCallResolver#resolve",
          fqName: "PythonCallResolver#resolve",
          shortName: "resolve",
          relPath: "src/resolvers/python/python-resolver.ts",
          scope: ["PythonCallResolver"],
        },
      ]);
      const resolver = new TSCallResolver({ baseUrl: ".", paths: {} });
      const result = resolver.resolve(
        { callText: "resolver.resolve(call, ctx)", receiver: "resolver", member: "resolve", startLine: 10 },
        {
          callerFile: "src/provider/provider.ts",
          callerScope: ["CodegraphProvider"],
          // Both implementations imported — still ambiguous.
          imports: [
            { importText: "../resolvers/ruby/ruby-resolver", startLine: 1 },
            { importText: "../resolvers/python/python-resolver", startLine: 2 },
          ],
          symbolTable,
        },
      );
      expect(result).toBeNull();
    });

    it("does NOT narrow when global short-name is unambiguous (N=1) — preserves existing fast path", () => {
      const symbolTable = new InMemoryGlobalSymbolTable();
      symbolTable.upsertFile("src/util.ts", [
        { symbolId: "helper", fqName: "helper", shortName: "helper", relPath: "src/util.ts", scope: [] },
      ]);
      const resolver = new TSCallResolver({ baseUrl: ".", paths: {} });
      // Unrelated import list — narrowing must not interfere with the
      // existing N=1 path that already resolves cleanly.
      const result = resolver.resolve(
        { callText: "helper()", receiver: null, member: "helper", startLine: 1 },
        {
          callerFile: "src/main.ts",
          callerScope: [],
          imports: [{ importText: "./unrelated", startLine: 1 }],
          symbolTable,
        },
      );
      expect(result).toEqual({ targetRelPath: "src/util.ts", targetSymbolId: "helper" });
    });
  });

  // bd tea-rags-mcp-x6ta — typed-parameter receiver resolution via
  // localBindings. A call `resolver.resolve(...)` where `resolver` is a
  // FUNCTION PARAMETER typed `CallResolver` previously dropped to the
  // ambiguous short-name fallback (one `#resolve` per `*CallResolver`
  // impl, all reachable via imports → nothing narrows → edge dropped).
  // The walker now records `resolver → CallResolver` on the chunk's
  // localBindings; the resolver consults it BEFORE the import-receiver
  // pass and pins the call to `<Type>#<member>`. Mirrors the Go / Python
  // `resolveByLocalType` contract: try `Type#member`, then `Type.member`,
  // and on miss fall through to the existing fallbacks (never fabricate).
  describe("typed-parameter receiver via localBindings (bd tea-rags-mcp-x6ta)", () => {
    it("pins param.method() to <Type>#<member> when localBindings binds the receiver (instance form)", () => {
      const symbolTable = new InMemoryGlobalSymbolTable();
      // A single concrete CallResolver class declares #resolve. There
      // are ALSO other `resolve` short-name matches in sibling files —
      // the import-narrowed fallback could not disambiguate because the
      // caller imports all of them. localBindings resolves it directly.
      symbolTable.upsertFile("src/resolvers/call-resolver.ts", [
        {
          symbolId: "CallResolver#resolve",
          fqName: "CallResolver#resolve",
          shortName: "resolve",
          relPath: "src/resolvers/call-resolver.ts",
          scope: ["CallResolver"],
        },
      ]);
      symbolTable.upsertFile("src/resolvers/python-resolver.ts", [
        {
          symbolId: "PythonCallResolver#resolve",
          fqName: "PythonCallResolver#resolve",
          shortName: "resolve",
          relPath: "src/resolvers/python-resolver.ts",
          scope: ["PythonCallResolver"],
        },
      ]);
      const resolver = new TSCallResolver({ baseUrl: ".", paths: {} });
      const result = resolver.resolve(
        { callText: "resolver.resolve(call, ctx)", receiver: "resolver", member: "resolve", startLine: 10 },
        {
          callerFile: "src/provider/provider.ts",
          callerScope: ["CodegraphProvider"],
          // Provider imports BOTH resolver files — short-name + import
          // narrowing would still be ambiguous. The local binding wins.
          imports: [
            { importText: "../resolvers/call-resolver", startLine: 1 },
            { importText: "../resolvers/python-resolver", startLine: 2 },
          ],
          symbolTable,
          localBindings: { resolver: "CallResolver" },
        },
      );
      expect(result).toEqual({
        targetRelPath: "src/resolvers/call-resolver.ts",
        targetSymbolId: "CallResolver#resolve",
      });
    });

    it("falls back to the static form <Type>.<member> when no instance method matches", () => {
      const symbolTable = new InMemoryGlobalSymbolTable();
      symbolTable.upsertFile("src/factory.ts", [
        {
          symbolId: "Factory.create",
          fqName: "Factory.create",
          shortName: "create",
          relPath: "src/factory.ts",
          scope: ["Factory"],
        },
      ]);
      const resolver = new TSCallResolver({ baseUrl: ".", paths: {} });
      const result = resolver.resolve(
        { callText: "f.create()", receiver: "f", member: "create", startLine: 3 },
        {
          callerFile: "src/main.ts",
          callerScope: [],
          imports: [],
          symbolTable,
          localBindings: { f: "Factory" },
        },
      );
      expect(result).toEqual({ targetRelPath: "src/factory.ts", targetSymbolId: "Factory.create" });
    });

    it("falls through to existing fallbacks when the bound type has no matching member (interface with no indexed impl)", () => {
      const symbolTable = new InMemoryGlobalSymbolTable();
      // `CallResolver` is an INTERFACE — no `CallResolver#resolve` symbol
      // exists (interfaces declare no method bodies). The single concrete
      // `resolve` short-name match is reachable via imports, so the
      // import-narrowed fallback recovers it. localBindings must NOT
      // fabricate a `CallResolver#resolve` edge — it returns nothing and
      // lets the lower-precedence path run.
      symbolTable.upsertFile("src/resolvers/ruby-resolver.ts", [
        {
          symbolId: "RubyCallResolver#resolve",
          fqName: "RubyCallResolver#resolve",
          shortName: "resolve",
          relPath: "src/resolvers/ruby-resolver.ts",
          scope: ["RubyCallResolver"],
        },
      ]);
      symbolTable.upsertFile("src/resolvers/python-resolver.ts", [
        {
          symbolId: "PythonCallResolver#resolve",
          fqName: "PythonCallResolver#resolve",
          shortName: "resolve",
          relPath: "src/resolvers/python-resolver.ts",
          scope: ["PythonCallResolver"],
        },
      ]);
      const resolver = new TSCallResolver({ baseUrl: ".", paths: {} });
      const result = resolver.resolve(
        { callText: "resolver.resolve()", receiver: "resolver", member: "resolve", startLine: 5 },
        {
          callerFile: "src/provider/provider.ts",
          callerScope: ["CodegraphProvider"],
          // Only the ruby impl is reachable via imports → import-narrowed
          // fallback picks it. Confirms typed-param miss is non-destructive.
          imports: [{ importText: "../resolvers/ruby-resolver", startLine: 1 }],
          symbolTable,
          localBindings: { resolver: "CallResolver" },
        },
      );
      expect(result).toEqual({
        targetRelPath: "src/resolvers/ruby-resolver.ts",
        targetSymbolId: "RubyCallResolver#resolve",
      });
    });

    it("does not consult localBindings for a receiver that is not a bound parameter", () => {
      const symbolTable = new InMemoryGlobalSymbolTable();
      symbolTable.upsertFile("src/util.ts", [
        { symbolId: "helper", fqName: "helper", shortName: "helper", relPath: "src/util.ts", scope: [] },
      ]);
      const resolver = new TSCallResolver({ baseUrl: ".", paths: {} });
      // `other.helper()` — `other` is not in localBindings, so the typed
      // path is skipped and global short-name resolves the single match.
      const result = resolver.resolve(
        { callText: "other.helper()", receiver: "other", member: "helper", startLine: 1 },
        {
          callerFile: "src/main.ts",
          callerScope: [],
          imports: [],
          symbolTable,
          localBindings: { resolver: "CallResolver" },
        },
      );
      expect(result).toEqual({ targetRelPath: "src/util.ts", targetSymbolId: "helper" });
    });
  });

  // bd tea-rags-mcp-4rgg — super() and super.foo() must route to the
  // PARENT class. Empirical from tea-rags self-test: every
  // `<Strategy>#constructor` had a super(...args) edge pointing at
  // itself (self-loop) because the resolver looked up the enclosing
  // class's own constructor. Mirrors Ruby's resolveSuper pattern but
  // uses single-inheritance classExtends.
  describe("super() / super.foo() resolution to parent class (bd tea-rags-mcp-4rgg)", () => {
    it("super() in constructor routes to parent class's constructor", () => {
      const symbolTable = new InMemoryGlobalSymbolTable();
      symbolTable.upsertFile("src/base.ts", [
        {
          symbolId: "Base#constructor",
          fqName: "Base#constructor",
          shortName: "constructor",
          relPath: "src/base.ts",
          scope: ["Base"],
        },
      ]);
      symbolTable.upsertFile("src/child.ts", [
        {
          symbolId: "Child#constructor",
          fqName: "Child#constructor",
          shortName: "constructor",
          relPath: "src/child.ts",
          scope: ["Child"],
        },
      ]);
      const resolver = new TSCallResolver({ baseUrl: ".", paths: {} });
      const result = resolver.resolve(
        { callText: "super(...args)", receiver: "super", member: "constructor", startLine: 3 },
        {
          callerFile: "src/child.ts",
          callerScope: ["Child"],
          imports: [],
          symbolTable,
          classExtends: { Child: "Base" },
        },
      );
      expect(result).toEqual({ targetRelPath: "src/base.ts", targetSymbolId: "Base#constructor" });
    });

    it("super.foo() routes to parent class's instance method foo", () => {
      const symbolTable = new InMemoryGlobalSymbolTable();
      symbolTable.upsertFile("src/base.ts", [
        {
          symbolId: "Base#foo",
          fqName: "Base#foo",
          shortName: "foo",
          relPath: "src/base.ts",
          scope: ["Base"],
        },
      ]);
      symbolTable.upsertFile("src/child.ts", [
        {
          symbolId: "Child#foo",
          fqName: "Child#foo",
          shortName: "foo",
          relPath: "src/child.ts",
          scope: ["Child"],
        },
      ]);
      const resolver = new TSCallResolver({ baseUrl: ".", paths: {} });
      const result = resolver.resolve(
        { callText: "super.foo()", receiver: "super", member: "foo", startLine: 2 },
        {
          callerFile: "src/child.ts",
          callerScope: ["Child"],
          imports: [],
          symbolTable,
          classExtends: { Child: "Base" },
        },
      );
      expect(result).toEqual({ targetRelPath: "src/base.ts", targetSymbolId: "Base#foo" });
    });

    it("walks transitively when direct parent lacks the method (B extends A extends C, C has bar)", () => {
      // class B extends A { foo() { super.bar(); } }
      // class A extends C {}                           — A doesn't define bar
      // class C { bar() {} }                           — C owns the method
      // The walk skips A and lands on C#bar.
      const symbolTable = new InMemoryGlobalSymbolTable();
      symbolTable.upsertFile("src/c.ts", [
        {
          symbolId: "C#bar",
          fqName: "C#bar",
          shortName: "bar",
          relPath: "src/c.ts",
          scope: ["C"],
        },
      ]);
      symbolTable.upsertFile("src/a.ts", []);
      symbolTable.upsertFile("src/b.ts", []);
      const resolver = new TSCallResolver({ baseUrl: ".", paths: {} });
      const result = resolver.resolve(
        { callText: "super.bar()", receiver: "super", member: "bar", startLine: 5 },
        {
          callerFile: "src/b.ts",
          callerScope: ["B"],
          imports: [],
          symbolTable,
          classExtends: { B: "A", A: "C" },
        },
      );
      expect(result).toEqual({ targetRelPath: "src/c.ts", targetSymbolId: "C#bar" });
    });

    it("returns null when parent class is external (not in symbol table)", () => {
      const symbolTable = new InMemoryGlobalSymbolTable();
      symbolTable.upsertFile("src/child.ts", [
        {
          symbolId: "Child#constructor",
          fqName: "Child#constructor",
          shortName: "constructor",
          relPath: "src/child.ts",
          scope: ["Child"],
        },
      ]);
      const resolver = new TSCallResolver({ baseUrl: ".", paths: {} });
      const result = resolver.resolve(
        { callText: "super()", receiver: "super", member: "constructor", startLine: 3 },
        {
          callerFile: "src/child.ts",
          callerScope: ["Child"],
          imports: [],
          symbolTable,
          // Parent declared in classExtends but not present in the
          // symbol table — external library, like `extends EventEmitter`.
          classExtends: { Child: "ExternalLib" },
        },
      );
      // Parent unknown — no edge rather than a fabricated target.
      expect(result).toBeNull();
    });

    it("does NOT produce a self-loop edge from super() to the enclosing class's own constructor", () => {
      // This is the empirical bug: ScrollRankStrategy#constructor called
      // super(...args) but the resolver returned ScrollRankStrategy#constructor
      // as the target (the SAME class). With no classExtends, we must
      // return null — the self-loop is worse than a missing edge.
      const symbolTable = new InMemoryGlobalSymbolTable();
      symbolTable.upsertFile("src/scroll-rank.ts", [
        {
          symbolId: "ScrollRankStrategy#constructor",
          fqName: "ScrollRankStrategy#constructor",
          shortName: "constructor",
          relPath: "src/scroll-rank.ts",
          scope: ["ScrollRankStrategy"],
        },
      ]);
      const resolver = new TSCallResolver({ baseUrl: ".", paths: {} });
      const result = resolver.resolve(
        { callText: "super(...args)", receiver: "super", member: "constructor", startLine: 7 },
        {
          callerFile: "src/scroll-rank.ts",
          callerScope: ["ScrollRankStrategy"],
          imports: [],
          symbolTable,
        },
      );
      // No classExtends → null (the only safe answer). MUST NOT route
      // back to ScrollRankStrategy#constructor.
      expect(result).toBeNull();
      expect(result).not.toEqual({
        targetRelPath: "src/scroll-rank.ts",
        targetSymbolId: "ScrollRankStrategy#constructor",
      });
    });

    it("preserves file-only edge when parent class is in classExtends but no symbol matches member", () => {
      // Parent class IS known in classExtends, but its file scope has
      // no matching member (e.g. method comes from a deeper ancestor
      // outside the project). Returning a file-level edge keeps fan-in
      // / fan-out accurate even when method-level pinning fails.
      const symbolTable = new InMemoryGlobalSymbolTable();
      symbolTable.upsertFile("src/base.ts", [
        {
          symbolId: "Base#constructor",
          fqName: "Base#constructor",
          shortName: "constructor",
          relPath: "src/base.ts",
          scope: ["Base"],
        },
      ]);
      const resolver = new TSCallResolver({ baseUrl: ".", paths: {} });
      const result = resolver.resolve(
        // `super.unknownMethod()` — parent's file is known but no symbol
        // matches `unknownMethod` in the chain.
        { callText: "super.unknownMethod()", receiver: "super", member: "unknownMethod", startLine: 4 },
        {
          callerFile: "src/child.ts",
          callerScope: ["Child"],
          imports: [],
          symbolTable,
          classExtends: { Child: "Base" },
        },
      );
      // File known, method unknown → file-only edge (mirrors Ruby
      // resolveSuper file-only fallback pattern).
      expect(result).toEqual({ targetRelPath: "src/base.ts", targetSymbolId: null });
    });
  });

  // bd tea-rags-mcp-kiuw — TypeScript kebab-case file → PascalCase class
  // naming convention. `import { RankModule } from "../rank-module.js"`
  // followed by `new RankModule()` produces a walker emission
  // `{receiver: "RankModule", member: "constructor"}`. The legacy
  // `importMatchesReceiver` compared the basename ("rank-module.js") to
  // the receiver ("RankModule") case-insensitively — the hyphen and the
  // file extension caused the compare to fail and the call dropped.
  //
  // Two fixes layered:
  //   1. Normalize-and-compare: strip extension + non-alphanumeric chars
  //      from the basename and case-fold both sides.
  //   2. Symbol-table FQN fallback: when normalize doesn't match, scan
  //      `symbolTable.lookup(receiver)` for any definition whose relPath
  //      matches one of the resolver-mapped imported files.
  describe("kebab-case file → PascalCase class import matching (bd tea-rags-mcp-kiuw)", () => {
    it("resolves new RankModule() against import { RankModule } from '../rank-module.js' (basename normalize)", () => {
      // Empirical case from tea-rags self-test: `scroll-rank.ts` has
      // `import { RankModule } from "../rank-module.js"` and calls
      // `new RankModule(...)`. The basename "rank-module.js" stripped of
      // extension and hyphens is "rankmodule", which case-folds to
      // "rankmodule" — matches `RankModule`.
      //
      // A SECOND file declares another `#constructor` so the bare
      // imports-narrowed fallback alone cannot pick a single winner —
      // the test specifically exercises the import-side basename match.
      const symbolTable = new InMemoryGlobalSymbolTable();
      symbolTable.upsertFile("src/explore/rank-module.ts", [
        {
          symbolId: "RankModule#constructor",
          fqName: "RankModule#constructor",
          shortName: "constructor",
          relPath: "src/explore/rank-module.ts",
          scope: ["RankModule"],
        },
      ]);
      // Unrelated other class with a `#constructor`. If the resolver
      // degraded to "global short-name search-code", it would have to
      // pick among two candidates. The fix should NOT need to fall
      // through to ambiguity resolution — the import basename match
      // must produce a clean N=1 picture.
      symbolTable.upsertFile("src/unrelated.ts", [
        {
          symbolId: "Other#constructor",
          fqName: "Other#constructor",
          shortName: "constructor",
          relPath: "src/unrelated.ts",
          scope: ["Other"],
        },
      ]);
      const resolver = new TSCallResolver({ baseUrl: ".", paths: {} });
      const result = resolver.resolve(
        { callText: "new RankModule(qdrant)", receiver: "RankModule", member: "constructor", startLine: 12 },
        {
          callerFile: "src/explore/strategies/scroll-rank.ts",
          callerScope: ["ScrollRankStrategy"],
          imports: [{ importText: "../rank-module.js", startLine: 1 }],
          symbolTable,
        },
      );
      expect(result).toEqual({
        targetRelPath: "src/explore/rank-module.ts",
        targetSymbolId: "RankModule#constructor",
      });
    });

    it("resolves new FooBarBaz() via symbol-table FQN fallback when filename does NOT mirror the class name", () => {
      // Filename "helpers" gives no syntactic hint about the contained
      // classes. Normalize cannot match "helpers" against "FooBarBaz".
      // The symbol-table FQN fallback walks `imp` -> mapImportToFile and
      // checks `symbolTable.lookup("FooBarBaz")` for any def in those
      // files — the def in src/helpers.ts wins.
      //
      // To prove the FQN path (not the bare imports-narrowed fallback)
      // is what wins, ANOTHER file holds another `#constructor` so the
      // short-name candidate set is ambiguous. Only the FQN-based file
      // restriction can narrow back to src/helpers.ts.
      const symbolTable = new InMemoryGlobalSymbolTable();
      symbolTable.upsertFile("src/helpers.ts", [
        {
          symbolId: "FooBarBaz#constructor",
          fqName: "FooBarBaz#constructor",
          shortName: "constructor",
          relPath: "src/helpers.ts",
          scope: ["FooBarBaz"],
        },
        {
          symbolId: "FooBarBaz",
          fqName: "FooBarBaz",
          shortName: "FooBarBaz",
          relPath: "src/helpers.ts",
          scope: [],
        },
      ]);
      symbolTable.upsertFile("src/unrelated.ts", [
        {
          symbolId: "Other#constructor",
          fqName: "Other#constructor",
          shortName: "constructor",
          relPath: "src/unrelated.ts",
          scope: ["Other"],
        },
      ]);
      const resolver = new TSCallResolver({ baseUrl: ".", paths: {} });
      const result = resolver.resolve(
        { callText: "new FooBarBaz()", receiver: "FooBarBaz", member: "constructor", startLine: 5 },
        {
          callerFile: "src/main.ts",
          callerScope: [],
          imports: [{ importText: "./helpers.js", startLine: 1 }],
          symbolTable,
        },
      );
      expect(result).toEqual({
        targetRelPath: "src/helpers.ts",
        targetSymbolId: "FooBarBaz#constructor",
      });
    });

    it("regression: Foo.method() with exact-name file match still resolves via normalize path", () => {
      // The vanilla "filename matches class name" case must still resolve
      // — proves the normalize layer is a SUPERSET of the legacy direct
      // compare, not a replacement that breaks the happy path.
      const symbolTable = new InMemoryGlobalSymbolTable();
      symbolTable.upsertFile("src/foo.ts", [
        { symbolId: "Foo.bar", fqName: "Foo.bar", shortName: "bar", relPath: "src/foo.ts", scope: ["Foo"] },
      ]);
      const resolver = new TSCallResolver({ baseUrl: ".", paths: {} });
      const result = resolver.resolve(
        { callText: "Foo.bar()", receiver: "Foo", member: "bar", startLine: 1 },
        {
          callerFile: "src/main.ts",
          callerScope: [],
          imports: [{ importText: "./foo", startLine: 1 }],
          symbolTable,
        },
      );
      expect(result).toEqual({ targetRelPath: "src/foo.ts", targetSymbolId: "Foo.bar" });
    });

    it("regression: unrelated receiver with no matching import still drops cleanly", () => {
      // Nothing in imports[] matches `unrelatedReceiver` via normalize OR
      // via symbol-table FQN. Must NOT fabricate a target. Falls through
      // to short-name `method` lookup — empty → null.
      const symbolTable = new InMemoryGlobalSymbolTable();
      symbolTable.upsertFile("src/foo.ts", [
        { symbolId: "Foo.bar", fqName: "Foo.bar", shortName: "bar", relPath: "src/foo.ts", scope: ["Foo"] },
      ]);
      const resolver = new TSCallResolver({ baseUrl: ".", paths: {} });
      const result = resolver.resolve(
        { callText: "unrelatedReceiver.method()", receiver: "unrelatedReceiver", member: "method", startLine: 1 },
        {
          callerFile: "src/main.ts",
          callerScope: [],
          imports: [{ importText: "./foo", startLine: 1 }],
          symbolTable,
        },
      );
      expect(result).toBeNull();
    });

    it("multi-export file: import { A, B } from './mixed.js'; new A() resolves to A not B", () => {
      // Two classes co-located in a single file. The normalize path
      // would match "mixed" against neither "A" nor "B" — both fall
      // through to the symbol-table FQN fallback. The fallback picks
      // the specific class that the receiver names (`A`), NOT the file's
      // first export.
      const symbolTable = new InMemoryGlobalSymbolTable();
      symbolTable.upsertFile("src/mixed.ts", [
        {
          symbolId: "A#constructor",
          fqName: "A#constructor",
          shortName: "constructor",
          relPath: "src/mixed.ts",
          scope: ["A"],
        },
        {
          symbolId: "B#constructor",
          fqName: "B#constructor",
          shortName: "constructor",
          relPath: "src/mixed.ts",
          scope: ["B"],
        },
        { symbolId: "A", fqName: "A", shortName: "A", relPath: "src/mixed.ts", scope: [] },
        { symbolId: "B", fqName: "B", shortName: "B", relPath: "src/mixed.ts", scope: [] },
      ]);
      const resolver = new TSCallResolver({ baseUrl: ".", paths: {} });
      const result = resolver.resolve(
        { callText: "new A()", receiver: "A", member: "constructor", startLine: 3 },
        {
          callerFile: "src/main.ts",
          callerScope: [],
          imports: [{ importText: "./mixed.js", startLine: 1 }],
          symbolTable,
        },
      );
      // Both constructors share shortName "constructor"; without the
      // FQN narrowing the lookupByShortName-filtered-by-file path would
      // be ambiguous (length 2) and strict would drop. The FQN check on
      // receiver="A" must constrain to A's file/symbol.
      expect(result).toEqual({ targetRelPath: "src/mixed.ts", targetSymbolId: "A#constructor" });
    });
  });
});
