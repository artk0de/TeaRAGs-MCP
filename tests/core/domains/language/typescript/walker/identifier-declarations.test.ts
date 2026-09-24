import Parser from "tree-sitter";
import TsLang from "tree-sitter-typescript";
import { describe, expect, it } from "vitest";

import type { WalkInput } from "../../../../../../src/core/contracts/types/language.js";
import { TypeScriptLanguage } from "../../../../../../src/core/domains/language/typescript/index.js";

function parse(src: string) {
  const p = new Parser();
  p.setLanguage(TsLang.typescript);
  return p.parse(src);
}

/** Through the COMPOSED walker, so the pass is exercised where production runs it. */
function declarationsOf(src: string, chunks: WalkInput["chunks"]) {
  return new TypeScriptLanguage().walker.walk({
    tree: parse(src),
    code: src,
    relPath: "a.ts",
    language: "typescript",
    chunks,
  }).identifierDeclarations;
}

// bd tea-rags-mcp-4p3sb.4 — the naming lexicon's syntactic half for TypeScript.
describe("TypeScript walker — identifier declarations", () => {
  const chunks = [
    { symbolId: "Svc", startLine: 1, endLine: 11, scope: [] },
    { symbolId: "Svc#constructor", startLine: 4, endLine: 4, scope: ["Svc"] },
    { symbolId: "Svc#load", startLine: 5, endLine: 10, scope: ["Svc"] },
  ];
  const src = [
    "class Svc {",
    "  private repo: Repo<Doc> = new Repo();",
    "  static count = new Counter();",
    "  constructor(private readonly db: Db, opt?: Options) {}",
    "  load(id: string, { a, b: c }: Opts, ...more: string[]) {",
    "    const doc = new Document(id);",
    "    let row = repo.get(id), n: number = 1;",
    "    const { d, e = 2, ...f } = obj;",
    "    const fn = (p: P) => p, g = new ns.Widget<string>();",
    "  }",
    "}",
  ].join("\n");

  it("records annotated and constructed fields, params and locals; destructuring binds each name untyped", () => {
    expect(declarationsOf(src, chunks)).toEqual([
      { name: "repo", kind: "field", line: 2, ownerSymbolId: "Svc", typeName: "Repo", typeSource: "annotation" },
      { name: "count", kind: "field", line: 3, ownerSymbolId: "Svc", typeName: "Counter", typeSource: "constructor" },
      {
        name: "db",
        kind: "param",
        line: 4,
        ownerSymbolId: "Svc#constructor",
        typeName: "Db",
        typeSource: "annotation",
      },
      {
        name: "opt",
        kind: "param",
        line: 4,
        ownerSymbolId: "Svc#constructor",
        typeName: "Options",
        typeSource: "annotation",
      },
      { name: "id", kind: "param", line: 5, ownerSymbolId: "Svc#load", typeName: "string", typeSource: "annotation" },
      { name: "a", kind: "param", line: 5, ownerSymbolId: "Svc#load" },
      { name: "c", kind: "param", line: 5, ownerSymbolId: "Svc#load" },
      { name: "more", kind: "param", line: 5, ownerSymbolId: "Svc#load" },
      {
        name: "doc",
        kind: "local",
        line: 6,
        ownerSymbolId: "Svc#load",
        typeName: "Document",
        typeSource: "constructor",
      },
      { name: "row", kind: "local", line: 7, ownerSymbolId: "Svc#load" },
      { name: "n", kind: "local", line: 7, ownerSymbolId: "Svc#load", typeName: "number", typeSource: "annotation" },
      { name: "d", kind: "local", line: 8, ownerSymbolId: "Svc#load" },
      { name: "e", kind: "local", line: 8, ownerSymbolId: "Svc#load" },
      { name: "f", kind: "local", line: 8, ownerSymbolId: "Svc#load" },
      { name: "fn", kind: "local", line: 9, ownerSymbolId: "Svc#load" },
      { name: "p", kind: "param", line: 9, ownerSymbolId: "Svc#load", typeName: "P", typeSource: "annotation" },
      {
        name: "g",
        kind: "local",
        line: 9,
        ownerSymbolId: "Svc#load",
        typeName: "ns.Widget",
        typeSource: "constructor",
      },
    ]);
  });
});
