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

function declarationsOf(src: string, chunks: WalkInput["chunks"]) {
  return new TypeScriptLanguage().walker.walk({
    tree: parse(src),
    code: src,
    relPath: "a.ts",
    language: "typescript",
    chunks,
  }).identifierDeclarations;
}

// bd tea-rags-mcp-4p3sb.4 — destructuring noise that binds nothing.
describe("TypeScript walker — destructuring patterns with non-binding members", () => {
  it("a comment inside an object pattern binds nothing; the names around it are kept", () => {
    const src = ["function run(o: Opts) {", "  const { a /* first */, b } = o;", "}"].join("\n");
    const chunks = [{ symbolId: "run", startLine: 1, endLine: 3, scope: [] }];
    expect(declarationsOf(src, chunks)).toEqual([
      { name: "o", kind: "param", line: 1, ownerSymbolId: "run", typeName: "Opts", typeSource: "annotation" },
      { name: "a", kind: "local", line: 2, ownerSymbolId: "run" },
      { name: "b", kind: "local", line: 2, ownerSymbolId: "run" },
    ]);
  });
});
