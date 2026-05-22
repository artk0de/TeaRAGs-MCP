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

  it("resolves super.X() against the enclosing class in the SAME file", () => {
    const symbolTable = new InMemoryGlobalSymbolTable();
    symbolTable.upsertFile("src/child.ts", [
      { symbolId: "Child.init", fqName: "Child.init", shortName: "init", relPath: "src/child.ts", scope: ["Child"] },
    ]);
    const resolver = new TSCallResolver({ baseUrl: ".", paths: {} });
    const result = resolver.resolve(
      { callText: "super.init()", receiver: "super", member: "init", startLine: 3 },
      {
        callerFile: "src/child.ts",
        callerScope: ["Child"],
        imports: [],
        symbolTable,
      },
    );
    expect(result).toEqual({ targetRelPath: "src/child.ts", targetSymbolId: "Child.init" });
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
});
