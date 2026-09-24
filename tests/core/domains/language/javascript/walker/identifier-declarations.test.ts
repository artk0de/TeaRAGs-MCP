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
function extractionOf(src: string, chunks: WalkInput["chunks"]) {
  return new JavaScriptLanguage().walker.walk({
    tree: parse(src),
    code: src,
    relPath: "a.js",
    language: "javascript",
    chunks,
  });
}

function declarationsOf(src: string, chunks: WalkInput["chunks"]) {
  return extractionOf(src, chunks).identifierDeclarations;
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
      {
        name: "repo",
        kind: "field",
        line: 2,
        ownerSymbolId: "Svc",
        typeName: "Repo",
        typeSource: "constructor",
        boundCallee: { member: "constructor", receiver: "Repo" },
      },
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
        boundCallee: { member: "constructor", receiver: "Document" },
      },
      {
        name: "row",
        kind: "local",
        line: 5,
        ownerSymbolId: "Svc#load",
        boundCallee: { member: "get", receiver: "repo" },
      },
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
        boundCallee: { member: "constructor", receiver: "ns.Widget" },
      },
    ]);
  });

  // bd tea-rags-mcp-4p3sb.16 — the row builder finds the CallRef by (startLine, member, receiver).
  it("binds a local / field to the outermost call, as the CallRef the walker emits on that line", () => {
    const code = [
      "class Repo {",
      "  cache = makeCache();",
      "  async load(id) {",
      "    const doc = await this.api.find(id);",
      "    const k = helper(1);",
      "    const lib = require('lib');",
      "    const n = 1;",
      "  }",
      "}",
    ].join("\n");
    const extraction = extractionOf(code, [
      { symbolId: "Repo", startLine: 1, endLine: 9, scope: [] },
      { symbolId: "Repo#load", startLine: 3, endLine: 8, scope: ["Repo"] },
    ]);
    const bound = Object.fromEntries((extraction.identifierDeclarations ?? []).map((d) => [d.name, d.boundCallee]));
    expect(bound).toEqual({
      cache: { member: "makeCache" },
      id: undefined,
      doc: { member: "find", receiver: "this.api" },
      k: { member: "helper" },
      // `require` is an import, not a call: the walker emits no CallRef for it.
      lib: undefined,
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
