import Parser from "tree-sitter";
import PyLang from "tree-sitter-python";
import { describe, expect, it } from "vitest";

import type { WalkInput } from "../../../../../../src/core/contracts/types/language.js";
import { PythonLanguage } from "../../../../../../src/core/domains/language/python/index.js";

function parse(src: string) {
  const p = new Parser();
  p.setLanguage(PyLang);
  return p.parse(src);
}

/** Through the COMPOSED walker, so the pass is exercised where production runs it. */
function declarationsOf(src: string, chunks: WalkInput["chunks"]) {
  return new PythonLanguage().walker.walk({ tree: parse(src), code: src, relPath: "a.py", language: "python", chunks })
    .identifierDeclarations;
}

// bd tea-rags-mcp-4p3sb.3 — the naming lexicon's syntactic half for Python.
describe("Python walker — identifier declarations", () => {
  it("records self, annotated params, constructor-typed locals and self fields", () => {
    const src = [
      "class Svc:",
      "    def load(self, repo: Repo):",
      "        doc = Document()",
      "        self.cache = Cache()",
    ].join("\n");
    const chunks = [
      { symbolId: "Svc", startLine: 1, endLine: 4, scope: [] },
      { symbolId: "Svc.load", startLine: 2, endLine: 4, scope: ["Svc"] },
    ];
    expect(declarationsOf(src, chunks)).toEqual([
      { name: "self", kind: "param", line: 2, ownerSymbolId: "Svc.load" },
      { name: "repo", kind: "param", line: 2, ownerSymbolId: "Svc.load", typeName: "Repo", typeSource: "annotation" },
      {
        name: "doc",
        kind: "local",
        line: 3,
        ownerSymbolId: "Svc.load",
        typeName: "Document",
        typeSource: "constructor",
      },
      {
        name: "cache",
        kind: "field",
        line: 4,
        ownerSymbolId: "Svc.load",
        typeName: "Cache",
        typeSource: "constructor",
      },
    ]);
  });

  it("covers default, typed-default and splat params, annotated locals, qualified constructors", () => {
    const src = [
      "def run(n=1, m: list[Job] = None, *args, **kw):",
      "    total: int = 0",
      "    inv = models.Invoice()",
      "    res = make_result()",
      "    other.cache = Cache()",
      "    a, b = 1, 2",
      "    total += 1",
    ].join("\n");
    const chunks = [{ symbolId: "run", startLine: 1, endLine: 7, scope: [] }];
    expect(declarationsOf(src, chunks)).toEqual([
      { name: "n", kind: "param", line: 1, ownerSymbolId: "run" },
      { name: "m", kind: "param", line: 1, ownerSymbolId: "run", typeName: "list", typeSource: "annotation" },
      { name: "args", kind: "param", line: 1, ownerSymbolId: "run" },
      { name: "kw", kind: "param", line: 1, ownerSymbolId: "run" },
      { name: "total", kind: "local", line: 2, ownerSymbolId: "run", typeName: "int", typeSource: "annotation" },
      {
        name: "inv",
        kind: "local",
        line: 3,
        ownerSymbolId: "run",
        typeName: "models.Invoice",
        typeSource: "constructor",
      },
      { name: "res", kind: "local", line: 4, ownerSymbolId: "run" },
    ]);
  });
});
