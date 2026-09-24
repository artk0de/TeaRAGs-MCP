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
function extractionOf(src: string, chunks: WalkInput["chunks"]) {
  return new JavaLanguage().walker.walk({ tree: parse(src), code: src, relPath: "Svc.java", language: "java", chunks });
}

function declarationsOf(src: string, chunks: WalkInput["chunks"]) {
  return extractionOf(src, chunks).identifierDeclarations;
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
      { name: "row", kind: "local", line: 6, ...owner, boundCallee: { member: "get", receiver: "repo" } },
      { name: "p", kind: "local", line: 7, ...owner, typeName: "com.acme.Panel", typeSource: "constructor" },
      {
        name: "ws",
        kind: "local",
        line: 8,
        ...owner,
        typeName: "Widget",
        typeSource: "annotation",
        boundCallee: { member: "make", receiver: "factory" },
      },
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

  // bd tea-rags-mcp-4p3sb.16 — the row builder finds the CallRef by (startLine, member, receiver).
  it("binds a local / field to the outermost call, as the CallRef the walker emits on that line", () => {
    const code = [
      "class Svc {",
      "  private Repo repo = Repos.create();",
      "  void load(String id) {",
      "    Doc doc = repo.find(id);",
      "    var all = find(id);",
      "    Doc made = new Doc();",
      "    int n = 1;",
      "  }",
      "}",
    ].join("\n");
    const extraction = extractionOf(code, [
      { symbolId: "Svc", startLine: 1, endLine: 9, scope: [] },
      { symbolId: "Svc#load", startLine: 3, endLine: 8, scope: ["Svc"] },
    ]);
    const bound = Object.fromEntries((extraction.identifierDeclarations ?? []).map((d) => [d.name, d.boundCallee]));
    expect(bound).toEqual({
      repo: { member: "create", receiver: "Repos" },
      id: undefined,
      doc: { member: "find", receiver: "repo" },
      all: { member: "find" },
      // The walker emits no CallRef for an object creation, so `new Doc()` binds nothing.
      made: undefined,
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
});
