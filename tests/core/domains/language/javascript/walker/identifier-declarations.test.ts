import Parser from "tree-sitter";
import JsLang from "tree-sitter-javascript";
import { describe, expect, it } from "vitest";

import type { WalkInput } from "../../../../../../src/core/contracts/types/language.js";
import { JavaScriptLanguage } from "../../../../../../src/core/domains/language/javascript/index.js";

function parse(src: string) {
  const p = new Parser();
  p.setLanguage(JsLang);
  return p.parse(src);
}

/** Through the COMPOSED walker, so the pass is exercised where production runs it. */
function declarationsOf(src: string, chunks: WalkInput["chunks"]) {
  return new JavaScriptLanguage().walker.walk({
    tree: parse(src),
    code: src,
    relPath: "a.js",
    language: "javascript",
    chunks,
  }).identifierDeclarations;
}

// bd tea-rags-mcp-4p3sb.4 — the naming lexicon's syntactic half for JavaScript.
describe("JavaScript walker — identifier declarations", () => {
  const chunks = [
    { symbolId: "Svc", startLine: 1, endLine: 10, scope: [] },
    { symbolId: "Svc#load", startLine: 3, endLine: 9, scope: ["Svc"] },
  ];
  const src = [
    "class Svc {",
    "  repo = new Repo();",
    "  load(id, opts = new Options(), { a, b: c }, [x, ...rest], ...more) {",
    "    const doc = new Document(id);",
    "    let row = repo.get(id), n;",
    "    var { d, e = 2, ...f } = obj;",
    "    const fn = (p, q = 1) => p, h = z => z;",
    "    const g = new ns.Widget();",
    "  }",
    "}",
  ].join("\n");

  it("records fields, every parameter form and locals; only `new X()` types a name", () => {
    expect(declarationsOf(src, chunks)).toEqual([
      { name: "repo", kind: "field", line: 2, ownerSymbolId: "Svc", typeName: "Repo", typeSource: "constructor" },
      { name: "id", kind: "param", line: 3, ownerSymbolId: "Svc#load" },
      {
        name: "opts",
        kind: "param",
        line: 3,
        ownerSymbolId: "Svc#load",
        typeName: "Options",
        typeSource: "constructor",
      },
      { name: "a", kind: "param", line: 3, ownerSymbolId: "Svc#load" },
      { name: "c", kind: "param", line: 3, ownerSymbolId: "Svc#load" },
      { name: "x", kind: "param", line: 3, ownerSymbolId: "Svc#load" },
      { name: "rest", kind: "param", line: 3, ownerSymbolId: "Svc#load" },
      { name: "more", kind: "param", line: 3, ownerSymbolId: "Svc#load" },
      {
        name: "doc",
        kind: "local",
        line: 4,
        ownerSymbolId: "Svc#load",
        typeName: "Document",
        typeSource: "constructor",
      },
      { name: "row", kind: "local", line: 5, ownerSymbolId: "Svc#load" },
      { name: "n", kind: "local", line: 5, ownerSymbolId: "Svc#load" },
      { name: "d", kind: "local", line: 6, ownerSymbolId: "Svc#load" },
      { name: "e", kind: "local", line: 6, ownerSymbolId: "Svc#load" },
      { name: "f", kind: "local", line: 6, ownerSymbolId: "Svc#load" },
      { name: "fn", kind: "local", line: 7, ownerSymbolId: "Svc#load" },
      { name: "p", kind: "param", line: 7, ownerSymbolId: "Svc#load" },
      { name: "q", kind: "param", line: 7, ownerSymbolId: "Svc#load" },
      { name: "h", kind: "local", line: 7, ownerSymbolId: "Svc#load" },
      { name: "z", kind: "param", line: 7, ownerSymbolId: "Svc#load" },
      {
        name: "g",
        kind: "local",
        line: 8,
        ownerSymbolId: "Svc#load",
        typeName: "ns.Widget",
        typeSource: "constructor",
      },
    ]);
  });
});
