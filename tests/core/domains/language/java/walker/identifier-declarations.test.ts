import Parser from "tree-sitter";
import JavaLang from "tree-sitter-java";
import { describe, expect, it } from "vitest";

import type { WalkInput } from "../../../../../../src/core/contracts/types/language.js";
import { JavaLanguage } from "../../../../../../src/core/domains/language/java/index.js";

function parse(src: string) {
  const p = new Parser();
  p.setLanguage(JavaLang);
  return p.parse(src);
}

/** Through the COMPOSED walker, so the pass is exercised where production runs it. */
function declarationsOf(src: string, chunks: WalkInput["chunks"]) {
  return new JavaLanguage().walker.walk({ tree: parse(src), code: src, relPath: "Svc.java", language: "java", chunks })
    .identifierDeclarations;
}

// bd tea-rags-mcp-4p3sb.6 — the naming lexicon's syntactic half for Java.
describe("Java walker — identifier declarations", () => {
  it("records fields per declarator, every parameter form and local; generic args dropped, arrays unwrapped", () => {
    const src = [
      "class Svc {",
      "  private Repo<Doc> repo = new Repo<>();",
      "  int a, b;",
      "  void load(String id, final List<Doc> xs, Item... more) {",
      "    Document doc = new Document(id);",
      "    var row = repo.get(id);",
      "    var p = new com.acme.Panel();",
      "    Widget[] ws = factory.make();",
      "    Runnable r = (x) -> {}, s = y -> {};",
      "    for (Item it : xs) {}",
      "    try (Reader rd = new FileReader(id)) {} catch (IOException e) {}",
      "  }",
      "}",
    ].join("\n");
    const chunks = [
      { symbolId: "Svc", startLine: 1, endLine: 13, scope: [] },
      { symbolId: "Svc#load", startLine: 4, endLine: 12, scope: ["Svc"] },
    ];
    const owner = { ownerSymbolId: "Svc#load" };
    expect(declarationsOf(src, chunks)).toEqual([
      { name: "repo", kind: "field", line: 2, ownerSymbolId: "Svc", typeName: "Repo", typeSource: "annotation" },
      { name: "a", kind: "field", line: 3, ownerSymbolId: "Svc", typeName: "int", typeSource: "annotation" },
      { name: "b", kind: "field", line: 3, ownerSymbolId: "Svc", typeName: "int", typeSource: "annotation" },
      { name: "id", kind: "param", line: 4, ...owner, typeName: "String", typeSource: "annotation" },
      { name: "xs", kind: "param", line: 4, ...owner, typeName: "List", typeSource: "annotation" },
      { name: "more", kind: "param", line: 4, ...owner, typeName: "Item", typeSource: "annotation" },
      { name: "doc", kind: "local", line: 5, ...owner, typeName: "Document", typeSource: "annotation" },
      { name: "row", kind: "local", line: 6, ...owner },
      { name: "p", kind: "local", line: 7, ...owner, typeName: "com.acme.Panel", typeSource: "constructor" },
      { name: "ws", kind: "local", line: 8, ...owner, typeName: "Widget", typeSource: "annotation" },
      // Pre-order: the statement declares `r` and `s` before its lambdas are visited.
      { name: "r", kind: "local", line: 9, ...owner, typeName: "Runnable", typeSource: "annotation" },
      { name: "s", kind: "local", line: 9, ...owner, typeName: "Runnable", typeSource: "annotation" },
      { name: "x", kind: "param", line: 9, ...owner },
      { name: "y", kind: "param", line: 9, ...owner },
      { name: "it", kind: "local", line: 10, ...owner, typeName: "Item", typeSource: "annotation" },
      { name: "rd", kind: "local", line: 11, ...owner, typeName: "Reader", typeSource: "annotation" },
      { name: "e", kind: "local", line: 11, ...owner, typeName: "IOException", typeSource: "annotation" },
    ]);
  });
});
