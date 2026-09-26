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

function declarationsOf(src: string, chunks: WalkInput["chunks"]) {
  return new PythonLanguage().walker.walk({ tree: parse(src), code: src, relPath: "a.py", language: "python", chunks })
    .identifierDeclarations;
}

// bd tea-rags-mcp-4p3sb.3 — shapes that declare a name but name no type.
describe("Python walker — identifier declarations that carry no type", () => {
  it("a bare `*` separator declares no param; a call through a subscript types nothing", () => {
    const src = ["def build(a, *, b):", "    x = makers[0]()", "    return x"].join("\n");
    const chunks = [{ symbolId: "build", startLine: 1, endLine: 3, scope: [] }];
    const owner = { ownerSymbolId: "build" };
    expect(declarationsOf(src, chunks)).toEqual([
      { name: "a", kind: "param", line: 1, ...owner },
      { name: "b", kind: "param", line: 1, ...owner },
      { name: "x", kind: "local", line: 2, ...owner },
    ]);
  });
});
