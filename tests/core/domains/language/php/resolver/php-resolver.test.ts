import { describe, expect, it } from "vitest";

import type {
  CallContext,
  FileExtraction,
  SymbolDefinition,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import { PhpImportFileMapper } from "../../../../../../src/core/domains/language/php/resolver/php-import-file-mapper.js";
import { PhpCallResolver } from "../../../../../../src/core/domains/language/php/resolver/php-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

function def(symbolId: string, relPath: string, symbolKind: SymbolDefinition["symbolKind"]): SymbolDefinition {
  const shortName = symbolId.split(/[#.]/).pop() ?? symbolId;
  return { symbolId, fqName: symbolId, shortName, relPath, scope: [], symbolKind };
}

function ctx(
  callerFile: string,
  callerScope: string[],
  table: InMemoryGlobalSymbolTable,
  extra: Partial<CallContext> = {},
): CallContext {
  return { callerFile, callerScope, imports: [], symbolTable: table, ...extra };
}

function extraction(relPath: string, importText: string): FileExtraction {
  return { relPath, language: "php", imports: [{ importText, startLine: 1 }], chunks: [], fileScope: [] };
}

describe("PhpCallResolver", () => {
  it("resolves $this->format() to the enclosing class method, not a global function", () => {
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("src/Greeter.php", [def("Greeter#format", "src/Greeter.php", "method")]);
    table.upsertFile("src/other.php", [def("format", "src/other.php", "function")]);
    const target = new PhpCallResolver().resolve(
      { callText: "$this->format($name)", receiver: "$this", member: "format", startLine: 4 },
      ctx("src/Greeter.php", ["Greeter"], table),
    );
    expect(target).toEqual({ targetRelPath: "src/Greeter.php", targetSymbolId: "Greeter#format" });
  });

  it("drops $this->missing() instead of binding a global function of that name", () => {
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("src/other.php", [def("missing", "src/other.php", "function")]);
    const target = new PhpCallResolver().resolve(
      { callText: "$this->missing()", receiver: "$this", member: "missing", startLine: 1 },
      ctx("src/Greeter.php", ["Greeter"], table),
    );
    expect(target).toBeNull();
  });

  it("resolves a same-file function call even when another file defines the same name", () => {
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("src/Greeter.php", [def("helper", "src/Greeter.php", "function")]);
    table.upsertFile("src/other.php", [def("helper", "src/other.php", "function")]);
    const target = new PhpCallResolver().resolve(
      { callText: "helper($name)", receiver: null, member: "helper", startLine: 5 },
      ctx("src/Greeter.php", ["Greeter"], table),
    );
    expect(target).toEqual({ targetRelPath: "src/Greeter.php", targetSymbolId: "helper" });
  });

  it("resolves a bare call to the unique function in another file", () => {
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("src/other.php", [def("helper", "src/other.php", "function")]);
    const target = new PhpCallResolver().resolve(
      { callText: "helper()", receiver: null, member: "helper", startLine: 1 },
      ctx("src/main.php", [], table),
    );
    expect(target).toEqual({ targetRelPath: "src/other.php", targetSymbolId: "helper" });
  });

  it("does not resolve $repo->save() to a function named save", () => {
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("src/other.php", [def("save", "src/other.php", "function")]);
    const target = new PhpCallResolver().resolve(
      { callText: "$repo->save()", receiver: "$repo", member: "save", startLine: 1 },
      ctx("src/Greeter.php", ["Greeter"], table),
    );
    expect(target).toBeNull();
  });

  it("does not resolve a bare call to a method that merely shares the name", () => {
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("src/Greeter.php", [def("Greeter#helper", "src/Greeter.php", "method")]);
    const target = new PhpCallResolver().resolve(
      { callText: "helper()", receiver: null, member: "helper", startLine: 1 },
      ctx("src/Greeter.php", ["Greeter"], table),
    );
    expect(target).toBeNull();
  });

  it("does not bind a qualified Foo\\bar() call to a function named bar", () => {
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("src/Greeter.php", [def("bar", "src/Greeter.php", "function")]);
    const target = new PhpCallResolver().resolve(
      { callText: "Foo\\bar($name)", receiver: null, member: "Foo\\bar", startLine: 1 },
      ctx("src/Greeter.php", [], table),
    );
    expect(target).toBeNull();
  });

  it("resolves Greeter::make() to the same-file method", () => {
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("src/Greeter.php", [def("Greeter#make", "src/Greeter.php", "method")]);
    const target = new PhpCallResolver().resolve(
      { callText: "Greeter::make()", receiver: "Greeter", member: "make", startLine: 2 },
      ctx("src/Greeter.php", ["Greeter"], table),
    );
    expect(target).toEqual({ targetRelPath: "src/Greeter.php", targetSymbolId: "Greeter#make" });
  });

  it("resolves self::make() to the enclosing class method", () => {
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("src/Greeter.php", [def("Greeter#make", "src/Greeter.php", "method")]);
    const target = new PhpCallResolver().resolve(
      { callText: "self::make()", receiver: "self", member: "make", startLine: 3 },
      ctx("src/Greeter.php", ["Greeter"], table),
    );
    expect(target).toEqual({ targetRelPath: "src/Greeter.php", targetSymbolId: "Greeter#make" });
  });

  it("resolves Bar::make() through a use that names one project file", () => {
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("src/Foo/Bar.php", [
      def("Bar", "src/Foo/Bar.php", "class"),
      def("Bar#make", "src/Foo/Bar.php", "method"),
    ]);
    table.upsertFile("src/main.php", [def("helper", "src/main.php", "function")]);
    const target = new PhpCallResolver().resolve(
      { callText: "Bar::make()", receiver: "Bar", member: "make", startLine: 4 },
      ctx("src/main.php", [], table, { imports: [{ importText: "Foo\\Bar", startLine: 2 }] }),
    );
    expect(target).toEqual({ targetRelPath: "src/Foo/Bar.php", targetSymbolId: "Bar#make" });
  });

  it("drops Bar::make() when the use is not in the index", () => {
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("src/main.php", [
      def("helper", "src/main.php", "function"),
      def("make", "src/main.php", "function"),
    ]);
    const target = new PhpCallResolver().resolve(
      { callText: "Bar::make()", receiver: "Bar", member: "make", startLine: 4 },
      ctx("src/main.php", [], table, { imports: [{ importText: "Foo\\Bar", startLine: 2 }] }),
    );
    expect(target).toBeNull();
  });

  it("resolves $repo->save() from a local binding and drops it when the type is unknown", () => {
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("src/Greeter.php", [
      def("Greeter#save", "src/Greeter.php", "method"),
      def("save", "src/other.php", "function"),
    ]);
    table.upsertFile("src/other.php", [def("save", "src/other.php", "function")]);
    const resolver = new PhpCallResolver();
    const call = { callText: "$repo->save()", receiver: "$repo", member: "save", startLine: 4 };
    const bound = resolver.resolve(
      call,
      ctx("src/main.php", [], table, { localBindings: { $repo: [{ line: 2, type: "Greeter" }] } }),
    );
    expect(bound).toEqual({ targetRelPath: "src/Greeter.php", targetSymbolId: "Greeter#save" });
    expect(resolver.resolve(call, ctx("src/main.php", [], table))).toBeNull();
  });

  it("maps a use to the indexed file and leaves a missing use without a path", () => {
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("src/Foo/Bar.php", [def("Bar", "src/Foo/Bar.php", "class")]);
    table.upsertFile("src/main.php", [def("helper", "src/main.php", "function")]);
    const resolver = new PhpCallResolver();
    expect(resolver.resolveFileEdges(extraction("src/main.php", "Foo\\Bar"), ctx("src/main.php", [], table))).toEqual([
      { targetRelPath: "src/Foo/Bar.php", importText: "Foo\\Bar" },
    ]);
    expect(
      resolver.resolveFileEdges(extraction("src/main.php", "Vendor\\Missing"), ctx("src/main.php", [], table)),
    ).toEqual([]);
    const mapper = new PhpImportFileMapper();
    expect(mapper.mapImportToFile("Vendor\\Missing", "src/main.php", ctx("src/main.php", [], table))).toEqual({
      kind: "unknown",
    });
    expect(
      mapper.mapImportToFile("Foo\\Bar", "src/main.php", ctx("src/main.php", [], new InMemoryGlobalSymbolTable())),
    ).toEqual({
      kind: "unknown",
    });
  });
});
