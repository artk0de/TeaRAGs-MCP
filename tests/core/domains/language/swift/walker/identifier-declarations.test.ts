import Parser from "tree-sitter";
import SwiftLang from "tree-sitter-swift";
import { describe, expect, it } from "vitest";

import type { WalkInput } from "../../../../../../src/core/contracts/types/language.js";
import { SwiftLanguage } from "../../../../../../src/core/domains/language/swift/index.js";
import { materializeTree } from "../../../../../../src/core/infra/materialize.js";

function parse(src: string) {
  const p = new Parser();
  p.setLanguage((SwiftLang as { default?: unknown }).default ?? SwiftLang);
  return p.parse(src);
}

/**
 * Through the COMPOSED walker, on the MATERIALIZED tree — the one the pipeline
 * walks. tree-sitter-swift registers `parameter.type` / `type_annotation.type`
 * under `name` as well, and materialization keeps only `name`, so a field read
 * of the type passes on a native tree and returns nothing in production.
 */
function extractionOf(src: string, chunks: WalkInput["chunks"]) {
  return new SwiftLanguage().walker.walk({
    tree: { rootNode: materializeTree(parse(src).rootNode, src) },
    code: src,
    relPath: "Sources/Svc.swift",
    language: "swift",
    chunks,
  });
}

function declarationsOf(src: string, chunks: WalkInput["chunks"]) {
  return extractionOf(src, chunks).identifierDeclarations;
}

// bd tea-rags-mcp-4p3sb.6 — the naming lexicon's syntactic half for Swift.
describe("Swift walker — identifier declarations", () => {
  it("records stored properties as fields, internal parameter names, locals; types read positionally", () => {
    const src = [
      "class Svc {",
      "  var repo: Repo = Repo()",
      "  let cache = Cache()",
      "  var items: [Item] = []",
      "  func load(id: String, _ doc: Doc, with opts: Options? = nil) {",
      "    let row = repo.get(id)",
      "    var w = Widget()",
      "    let x: Int = 1, y = Foo.Bar()",
      "    let (a, b) = (1, 2)",
      "    let cl = { (k: Key) in k }",
      "  }",
      "}",
    ].join("\n");
    const chunks = [
      { symbolId: "Svc", startLine: 1, endLine: 12, scope: [] },
      { symbolId: "Svc#load", startLine: 5, endLine: 11, scope: ["Svc"] },
    ];
    const owner = { ownerSymbolId: "Svc#load" };
    expect(declarationsOf(src, chunks)).toEqual([
      {
        name: "repo",
        kind: "field",
        line: 2,
        ownerSymbolId: "Svc",
        typeName: "Repo",
        typeSource: "annotation",
        boundCallee: { member: "Repo" },
      },
      {
        name: "cache",
        kind: "field",
        line: 3,
        ownerSymbolId: "Svc",
        typeName: "Cache",
        typeSource: "constructor",
        boundCallee: { member: "Cache" },
      },
      {
        name: "items",
        kind: "field",
        line: 4,
        ownerSymbolId: "Svc",
        typeName: "Item",
        typeSource: "annotation",
        typeMultiplicity: "many",
      },
      { name: "id", kind: "param", line: 5, ...owner, typeName: "String", typeSource: "annotation" },
      { name: "doc", kind: "param", line: 5, ...owner, typeName: "Doc", typeSource: "annotation" },
      { name: "opts", kind: "param", line: 5, ...owner, typeName: "Options", typeSource: "annotation" },
      { name: "row", kind: "local", line: 6, ...owner, boundCallee: { member: "get", receiver: "repo" } },
      {
        name: "w",
        kind: "local",
        line: 7,
        ...owner,
        typeName: "Widget",
        typeSource: "constructor",
        boundCallee: { member: "Widget" },
      },
      { name: "x", kind: "local", line: 8, ...owner, typeName: "Int", typeSource: "annotation" },
      {
        name: "y",
        kind: "local",
        line: 8,
        ...owner,
        typeName: "Foo.Bar",
        typeSource: "constructor",
        boundCallee: { member: "Bar", receiver: "Foo" },
      },
      { name: "a", kind: "local", line: 9, ...owner },
      { name: "b", kind: "local", line: 9, ...owner },
      { name: "cl", kind: "local", line: 10, ...owner },
      { name: "k", kind: "param", line: 10, ...owner, typeName: "Key", typeSource: "annotation" },
    ]);
  });

  // bd tea-rags-mcp-4p3sb.16 — the row builder finds the CallRef by (startLine, member, receiver).
  it("binds a local / field to the outermost call, as the CallRef the walker emits on that line", () => {
    const code = [
      "class Svc {",
      "  func load(id: String) async throws {",
      "    let a = try fetch(id)",
      "    let b = await api.get(id)",
      "    let c = try await api.get(id)",
      "    let d = try? fetch(id)",
      "    let p = Protected<[Int]>(1)",
      "    let n = 1",
      "  }",
      "}",
    ].join("\n");
    const extraction = extractionOf(code, [
      { symbolId: "Svc", startLine: 1, endLine: 10, scope: [] },
      { symbolId: "Svc#load", startLine: 2, endLine: 9, scope: ["Svc"] },
    ]);
    const bound = Object.fromEntries((extraction.identifierDeclarations ?? []).map((d) => [d.name, d.boundCallee]));
    expect(bound).toEqual({
      id: undefined,
      a: { member: "fetch" },
      b: { member: "get", receiver: "api" },
      c: { member: "get", receiver: "api" },
      d: { member: "fetch" },
      p: { member: "Protected" },
      n: undefined,
    });
    for (const declaration of extraction.identifierDeclarations ?? []) {
      if (declaration.boundCallee === undefined) continue;
      const onLine = extraction.chunks
        .flatMap((chunk) => chunk.calls)
        .filter((call) => call.startLine === declaration.line)
        .map((call) =>
          call.receiver === null ? { member: call.member } : { member: call.member, receiver: call.receiver },
        );
      expect(onLine).toContainEqual(declaration.boundCallee);
    }
  });

  // bd tea-rags-mcp-4p3sb.21 — the call-return join reads the TARGET's return row.
  it("records each func's return type as a return of the func's own chunk, read positionally", () => {
    const code = [
      "final class Store<Value> {",
      "  func load(id: String) async throws -> Doc { fatalError() }",
      "  func all() -> [Job] { [] }",
      "  static func make() -> Self { fatalError() }",
      "  func decode<T>() -> T { fatalError() }",
      "  func value() -> Value { fatalError() }",
      "  func run() -> Void {}",
      "  func stop() {}",
      "}",
      "protocol Api { func copy() -> Self }",
    ].join("\n");
    const declarations = declarationsOf(code, [
      { symbolId: "Store", startLine: 1, endLine: 9, scope: [] },
      { symbolId: "Store#load", startLine: 2, endLine: 2, scope: ["Store"] },
      { symbolId: "Store#all", startLine: 3, endLine: 3, scope: ["Store"] },
      { symbolId: "Store.make", startLine: 4, endLine: 4, scope: ["Store"] },
      { symbolId: "Store#decode", startLine: 5, endLine: 5, scope: ["Store"] },
      { symbolId: "Store#value", startLine: 6, endLine: 6, scope: ["Store"] },
      { symbolId: "Store#run", startLine: 7, endLine: 7, scope: ["Store"] },
      { symbolId: "Store#stop", startLine: 8, endLine: 8, scope: ["Store"] },
      { symbolId: "Api", startLine: 10, endLine: 10, scope: [] },
      { symbolId: "Api#copy", startLine: 10, endLine: 10, scope: ["Api"] },
    ]);
    expect((declarations ?? []).filter((d) => d.kind === "return")).toEqual([
      { name: "load", kind: "return", line: 2, ownerSymbolId: "Store#load", typeName: "Doc", typeSource: "annotation" },
      {
        name: "all",
        kind: "return",
        line: 3,
        ownerSymbolId: "Store#all",
        typeName: "Job",
        typeSource: "annotation",
        typeMultiplicity: "many",
      },
      // `Self` in a type body names the declaring type; a generic parameter and `Void` name none.
      {
        name: "make",
        kind: "return",
        line: 4,
        ownerSymbolId: "Store.make",
        typeName: "Store",
        typeSource: "annotation",
      },
    ]);
  });

  // bd tea-rags-mcp-4p3sb.17 — a collection or wrapper names its element; maps keep their head.
  it("unwraps Array<T> / Set<T> / Optional<T> to the element, read positionally", () => {
    const code = [
      "func f(a: Array<Job>, b: Set<Tag>, c: Optional<Repo>, e: Dictionary<String, Job>, g: Array<[Job]>,",
      "       h: Swift.Array<Job>, i: Set<Job>?, j: Array<(Int, Int)>, k: [Set<Tag>], l: Optional<Array<Repo>>) {}",
    ].join("\n");
    const declarations = declarationsOf(code, [{ symbolId: "f", startLine: 1, endLine: 2, scope: [] }]);
    expect(Object.fromEntries((declarations ?? []).map((d) => [d.name, d.typeName]))).toEqual({
      a: "Job",
      b: "Tag",
      c: "Repo",
      e: "Dictionary",
      g: "Job",
      h: "Job",
      i: "Job",
      j: undefined,
      k: "Tag",
      l: "Repo",
    });
  });
});

// bd tea-rags-mcp-4p3sb.26 — array sugar and sequences name their element AND say they hold many.
describe("Swift walker — identifier type multiplicity", () => {
  it("marks [T], Array / Set and an optional array many; T?, Optional<T> and a dictionary stay one", () => {
    const src = [
      "class Svc {",
      "  var items: [Item] = []",
      "  func pick(candidates: [Item], fallback: Item, set: Set<Item>, opt: Item?, opts: [Item]?,",
      "            wrapped: Optional<Item>, arr: Array<Item>, byId: [String: Item], rest: Item...) -> [Item] {",
      "    let seen: Set<Item> = []",
      "    return []",
      "  }",
      "}",
    ].join("\n");
    const chunks = [
      { symbolId: "Svc", startLine: 1, endLine: 8, scope: [] },
      { symbolId: "Svc#pick", startLine: 3, endLine: 7, scope: ["Svc"] },
    ];
    const declarations = declarationsOf(src, chunks) ?? [];
    expect(declarations.map((d) => [d.kind, d.name, d.typeName, d.typeMultiplicity ?? "one"])).toEqual([
      ["field", "items", "Item", "many"],
      ["return", "pick", "Item", "many"],
      ["param", "candidates", "Item", "many"],
      ["param", "fallback", "Item", "one"],
      ["param", "set", "Item", "many"],
      ["param", "opt", "Item", "one"],
      ["param", "opts", "Item", "many"],
      ["param", "wrapped", "Item", "one"],
      ["param", "arr", "Item", "many"],
      ["param", "byId", undefined, "one"],
      ["param", "rest", "Item", "many"],
      ["local", "seen", "Item", "many"],
    ]);
  });
});
