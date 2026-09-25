import Parser from "tree-sitter";
import GoLang from "tree-sitter-go";
import { describe, expect, it } from "vitest";

import type { WalkInput } from "../../../../../../src/core/contracts/types/language.js";
import { GoLanguage } from "../../../../../../src/core/domains/language/go/index.js";

function parse(src: string) {
  const p = new Parser();
  p.setLanguage(GoLang);
  return p.parse(src);
}

function declarationsOf(src: string, chunks: WalkInput["chunks"]) {
  return new GoLanguage().walker.walk({ tree: parse(src), code: src, relPath: "svc.go", language: "go", chunks })
    .identifierDeclarations;
}

// bd tea-rags-mcp-4p3sb.5 — assignment forms that declare nothing.
describe("Go walker — range clauses that assign rather than declare", () => {
  it("`for i, v := range` declares both names; `for i, v = range` reuses existing ones", () => {
    const src = [
      "package p",
      "func run(xs []int) {",
      "\tvar i, v int",
      "\tfor i, v = range xs {",
      "\t}",
      "\tfor k, w := range xs {",
      "\t}",
      "}",
    ].join("\n");
    const chunks = [{ symbolId: "run", startLine: 2, endLine: 8, scope: [] }];
    const owner = { ownerSymbolId: "run" };
    const int = { typeName: "int", typeSource: "annotation" };
    expect(declarationsOf(src, chunks)).toEqual([
      { name: "xs", kind: "param", line: 2, ...owner, ...int },
      { name: "i", kind: "local", line: 3, ...owner, ...int },
      { name: "v", kind: "local", line: 3, ...owner, ...int },
      // line 4 (`=`) re-declares nothing
      { name: "k", kind: "local", line: 6, ...owner },
      { name: "w", kind: "local", line: 6, ...owner },
    ]);
  });
});
