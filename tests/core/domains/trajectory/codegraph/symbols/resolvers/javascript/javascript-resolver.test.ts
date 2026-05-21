import { describe, expect, it } from "vitest";

import type { CallContext } from "../../../../../../../../src/core/contracts/types/codegraph.js";
import {
  JavascriptCallResolver,
  mapJavascriptImportToFile,
} from "../../../../../../../../src/core/domains/trajectory/codegraph/symbols/resolvers/javascript/javascript-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

function ctx(
  callerFile: string,
  imports: { importText: string; startLine: number }[],
  table: InMemoryGlobalSymbolTable,
): CallContext {
  return { callerFile, callerScope: [], imports, symbolTable: table };
}

describe("mapJavascriptImportToFile", () => {
  it("relative import resolves with .js extension by default", () => {
    expect(mapJavascriptImportToFile("./foo", "pkg/main.js")).toBe("pkg/foo.js");
  });

  it("preserves explicit .js extension", () => {
    expect(mapJavascriptImportToFile("./foo.js", "pkg/main.js")).toBe("pkg/foo.js");
  });

  it("preserves explicit .mjs extension", () => {
    expect(mapJavascriptImportToFile("./foo.mjs", "pkg/main.mjs")).toBe("pkg/foo.mjs");
  });

  it("parent path resolves with normalization", () => {
    expect(mapJavascriptImportToFile("../foo", "pkg/sub/x.js")).toBe("pkg/foo.js");
  });

  it("returns null for bare specifiers (npm packages)", () => {
    expect(mapJavascriptImportToFile("lodash", "x.js")).toBeNull();
  });
});

describe("JavascriptCallResolver", () => {
  it("resolves receiver-matched relative import to known file", () => {
    const r = new JavascriptCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    t.upsertFile("pkg/foo.js", [
      { symbolId: "bar", fqName: "bar", shortName: "bar", relPath: "pkg/foo.js", scope: [] },
    ]);
    const target = r.resolve(
      { callText: "foo.bar()", receiver: "foo", member: "bar", startLine: 3 },
      ctx("pkg/main.js", [{ importText: "./foo", startLine: 1 }], t),
    );
    expect(target?.targetRelPath).toBe("pkg/foo.js");
    expect(target?.targetSymbolId).toBe("bar");
  });

  it("matches import basename ignoring .js extension", () => {
    const r = new JavascriptCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    t.upsertFile("pkg/foo.js", [
      { symbolId: "bar", fqName: "bar", shortName: "bar", relPath: "pkg/foo.js", scope: [] },
    ]);
    const target = r.resolve(
      { callText: "foo.bar()", receiver: "foo", member: "bar", startLine: 3 },
      ctx("pkg/main.js", [{ importText: "./foo.js", startLine: 1 }], t),
    );
    expect(target?.targetRelPath).toBe("pkg/foo.js");
  });

  it("falls back to global short-name when no receiver", () => {
    const r = new JavascriptCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    t.upsertFile("helpers.js", [
      { symbolId: "doThing", fqName: "doThing", shortName: "doThing", relPath: "helpers.js", scope: [] },
    ]);
    const target = r.resolve(
      { callText: "doThing()", receiver: null, member: "doThing", startLine: 1 },
      ctx("main.js", [], t),
    );
    expect(target?.targetRelPath).toBe("helpers.js");
  });

  it("returns target file with null symbol id when import matches but symbol unknown", () => {
    const r = new JavascriptCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    const target = r.resolve(
      { callText: "foo.ghost()", receiver: "foo", member: "ghost", startLine: 1 },
      ctx("pkg/main.js", [{ importText: "./foo", startLine: 1 }], t),
    );
    expect(target?.targetRelPath).toBe("pkg/foo.js");
    expect(target?.targetSymbolId).toBeNull();
  });

  it("returns null for bare specifier imports (out of scope)", () => {
    const r = new JavascriptCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    const target = r.resolve(
      { callText: "lodash.get()", receiver: "lodash", member: "get", startLine: 1 },
      ctx("main.js", [{ importText: "lodash", startLine: 1 }], t),
    );
    expect(target).toBeNull();
  });

  // The `this.X()` / `super.X()` block (lines 44-53) routes intra-class
  // calls through the same instance/static lookup ladder the TS resolver
  // uses, so JS classes get correct edges to instance methods on the
  // enclosing class. These were uncovered until Slice 2.
  describe("intra-class this/super dispatch (symbolId convention)", () => {
    it("resolves this.X() to <EnclosingClass>#<member> in the SAME file (instance method)", () => {
      const r = new JavascriptCallResolver();
      const t = new InMemoryGlobalSymbolTable();
      t.upsertFile("src/store.js", [
        {
          symbolId: "Store#read",
          fqName: "Store#read",
          shortName: "read",
          relPath: "src/store.js",
          scope: ["Store"],
        },
      ]);
      const target = r.resolve(
        { callText: "this.read()", receiver: "this", member: "read", startLine: 5 },
        {
          callerFile: "src/store.js",
          callerScope: ["Store"],
          imports: [],
          symbolTable: t,
        },
      );
      expect(target?.targetRelPath).toBe("src/store.js");
      expect(target?.targetSymbolId).toBe("Store#read");
    });

    it("resolves super.X() against the enclosing class in the SAME file", () => {
      const r = new JavascriptCallResolver();
      const t = new InMemoryGlobalSymbolTable();
      t.upsertFile("src/child.js", [
        { symbolId: "Child#init", fqName: "Child#init", shortName: "init", relPath: "src/child.js", scope: ["Child"] },
      ]);
      const target = r.resolve(
        { callText: "super.init()", receiver: "super", member: "init", startLine: 3 },
        { callerFile: "src/child.js", callerScope: ["Child"], imports: [], symbolTable: t },
      );
      expect(target?.targetSymbolId).toBe("Child#init");
    });

    it("falls back to <EnclosingClass>.<member> (static dispatch) when instance form is absent", () => {
      const r = new JavascriptCallResolver();
      const t = new InMemoryGlobalSymbolTable();
      t.upsertFile("src/util.js", [
        {
          symbolId: "Util.make",
          fqName: "Util.make",
          shortName: "make",
          relPath: "src/util.js",
          scope: ["Util"],
        },
      ]);
      const target = r.resolve(
        { callText: "this.make()", receiver: "this", member: "make", startLine: 4 },
        { callerFile: "src/util.js", callerScope: ["Util"], imports: [], symbolTable: t },
      );
      expect(target?.targetSymbolId).toBe("Util.make");
    });

    it("falls back to same-file short-name when no instance/static form matches", () => {
      const r = new JavascriptCallResolver();
      const t = new InMemoryGlobalSymbolTable();
      t.upsertFile("src/mixed.js", [
        // top-level helper, NOT class-scoped — shortName lookup wins
        { symbolId: "helper", fqName: "helper", shortName: "helper", relPath: "src/mixed.js", scope: [] },
      ]);
      const target = r.resolve(
        { callText: "this.helper()", receiver: "this", member: "helper", startLine: 6 },
        { callerFile: "src/mixed.js", callerScope: ["Container"], imports: [], symbolTable: t },
      );
      expect(target?.targetSymbolId).toBe("helper");
    });

    it("does NOT misroute this.X() when callerScope is empty (top-level function context)", () => {
      const r = new JavascriptCallResolver();
      const t = new InMemoryGlobalSymbolTable();
      t.upsertFile("src/other.js", [
        { symbolId: "Foo#bar", fqName: "Foo#bar", shortName: "bar", relPath: "src/other.js", scope: ["Foo"] },
      ]);
      // Empty callerScope skips the this/super block entirely — the
      // receiver path falls through to global short-name lookup.
      const target = r.resolve(
        { callText: "this.bar()", receiver: "this", member: "bar", startLine: 1 },
        { callerFile: "src/caller.js", callerScope: [], imports: [], symbolTable: t },
      );
      expect(target?.targetRelPath).toBe("src/other.js");
      expect(target?.targetSymbolId).toBe("Foo#bar");
    });
  });
});
