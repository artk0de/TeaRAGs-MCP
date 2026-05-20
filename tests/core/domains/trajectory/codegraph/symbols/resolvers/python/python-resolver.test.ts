import { describe, expect, it } from "vitest";

import type { CallContext } from "../../../../../../../../src/core/contracts/types/codegraph.js";
import { mapPythonImportToFile } from "../../../../../../../../src/core/domains/trajectory/codegraph/symbols/resolvers/python/python-path-mapper.js";
import { PythonCallResolver } from "../../../../../../../../src/core/domains/trajectory/codegraph/symbols/resolvers/python/python-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

describe("mapPythonImportToFile", () => {
  it("absolute single-segment module → .py", () => {
    expect(mapPythonImportToFile("foo", "a/b.py")).toBe("foo.py");
  });

  it("absolute dotted module → path.py", () => {
    expect(mapPythonImportToFile("foo.bar.baz", "x.py")).toBe("foo/bar/baz.py");
  });

  it("relative one-dot resolves to sibling", () => {
    expect(mapPythonImportToFile(".foo", "pkg/main.py")).toBe("pkg/foo.py");
  });

  it("relative two-dot resolves to parent", () => {
    expect(mapPythonImportToFile("..foo", "pkg/sub/main.py")).toBe("pkg/foo.py");
  });

  it("relative two-dot dotted module: ..foo.bar from pkg/sub/x.py → pkg/foo/bar.py", () => {
    expect(mapPythonImportToFile("..foo.bar", "pkg/sub/x.py")).toBe("pkg/foo/bar.py");
  });

  it("triple-dot resolves two levels up", () => {
    expect(mapPythonImportToFile("...foo", "a/b/c/main.py")).toBe("a/foo.py");
  });

  it("`.` alone (from . import x) returns null (no specific file)", () => {
    expect(mapPythonImportToFile(".", "pkg/x.py")).toBeNull();
  });

  it("strips ` as alias` suffix tolerantly (walker normalises but guard helps)", () => {
    expect(mapPythonImportToFile("numpy as np", "a.py")).toBe("numpy.py");
  });

  it("empty input returns null", () => {
    expect(mapPythonImportToFile("", "a.py")).toBeNull();
  });
});

describe("PythonCallResolver", () => {
  function makeCtx(
    callerFile: string,
    imports: { importText: string; startLine: number }[],
    symbolTable: InMemoryGlobalSymbolTable,
  ): CallContext {
    return { callerFile, callerScope: [], imports, symbolTable };
  }

  it("resolves `foo.bar()` when the import matches the receiver", () => {
    const resolver = new PythonCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("foo.py", [
      { symbolId: "foo.bar", fqName: "foo.bar", shortName: "bar", relPath: "foo.py", scope: ["foo"] },
    ]);
    const target = resolver.resolve(
      { callText: "foo.bar()", receiver: "foo", member: "bar", startLine: 5 },
      makeCtx("main.py", [{ importText: "foo", startLine: 1 }], table),
    );
    expect(target?.targetRelPath).toBe("foo.py");
    expect(target?.targetSymbolId).toBe("foo.bar");
  });

  it("matches dotted import by trailing segment (from a.b import => receiver b)", () => {
    const resolver = new PythonCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("a/b.py", [
      { symbolId: "a.b.c", fqName: "a.b.c", shortName: "c", relPath: "a/b.py", scope: ["a", "b"] },
    ]);
    const target = resolver.resolve(
      { callText: "b.c()", receiver: "b", member: "c", startLine: 4 },
      makeCtx("main.py", [{ importText: "a.b", startLine: 1 }], table),
    );
    expect(target?.targetRelPath).toBe("a/b.py");
  });

  it("matches relative imports by trailing segment", () => {
    const resolver = new PythonCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("pkg/foo.py", [
      { symbolId: "pkg.foo.bar", fqName: "pkg.foo.bar", shortName: "bar", relPath: "pkg/foo.py", scope: [] },
    ]);
    const target = resolver.resolve(
      { callText: "foo.bar()", receiver: "foo", member: "bar", startLine: 3 },
      makeCtx("pkg/main.py", [{ importText: ".foo", startLine: 1 }], table),
    );
    expect(target?.targetRelPath).toBe("pkg/foo.py");
  });

  it("returns null when the import resolves but no symbol matches by short-name (target file is known)", () => {
    const resolver = new PythonCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    const target = resolver.resolve(
      { callText: "foo.ghost()", receiver: "foo", member: "ghost", startLine: 1 },
      makeCtx("main.py", [{ importText: "foo", startLine: 1 }], table),
    );
    // No matching symbol in table — resolver records target file with
    // null symbol id so the file-edge still gets attribution.
    expect(target?.targetRelPath).toBe("foo.py");
    expect(target?.targetSymbolId).toBeNull();
  });

  it("falls back to global short-name lookup when no receiver", () => {
    const resolver = new PythonCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("helper.py", [
      { symbolId: "do_thing", fqName: "do_thing", shortName: "do_thing", relPath: "helper.py", scope: [] },
    ]);
    const target = resolver.resolve(
      { callText: "do_thing()", receiver: null, member: "do_thing", startLine: 1 },
      makeCtx("main.py", [], table),
    );
    expect(target?.targetRelPath).toBe("helper.py");
  });

  it("returns null when global short-name lookup is ambiguous", () => {
    const resolver = new PythonCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("a.py", [
      { symbolId: "do_thing", fqName: "do_thing", shortName: "do_thing", relPath: "a.py", scope: [] },
    ]);
    table.upsertFile("b.py", [
      { symbolId: "do_thing", fqName: "do_thing", shortName: "do_thing", relPath: "b.py", scope: [] },
    ]);
    const target = resolver.resolve(
      { callText: "do_thing()", receiver: null, member: "do_thing", startLine: 1 },
      makeCtx("main.py", [], table),
    );
    // Two candidates — resolver refuses to guess.
    expect(target).toBeNull();
  });

  it("is case-sensitive (Python convention)", () => {
    const resolver = new PythonCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("foo.py", [
      { symbolId: "Foo.do", fqName: "Foo.do", shortName: "do", relPath: "foo.py", scope: ["Foo"] },
    ]);
    const target = resolver.resolve(
      { callText: "FOO.do()", receiver: "FOO", member: "do", startLine: 1 },
      // 'FOO' doesn't match 'foo' (case-sensitive), so the import-list
      // path fails → falls back to global short-name (do unique here).
      makeCtx("main.py", [{ importText: "foo", startLine: 1 }], table),
    );
    expect(target?.targetRelPath).toBe("foo.py");
  });
});
