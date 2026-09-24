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
      { name: "items", kind: "field", line: 4, ownerSymbolId: "Svc", typeName: "Item", typeSource: "annotation" },
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
