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

/** On the MATERIALIZED tree, the one the pipeline walks. */
function declarationsOf(src: string, chunks: WalkInput["chunks"]) {
  return new SwiftLanguage().walker.walk({
    tree: { rootNode: materializeTree(parse(src).rootNode, src) },
    code: src,
    relPath: "Sources/Svc.swift",
    language: "swift",
    chunks,
  }).identifierDeclarations;
}

// bd tea-rags-mcp-4p3sb.7 — shapes that declare a name but name no element or constructed type.
describe("Swift walker — identifier declarations that carry no inferred type", () => {
  it("a bare `Array` annotation names itself; subscript and chained callees construct nothing", () => {
    const src = [
      "struct Svc {",
      "  func run() {",
      "    let xs: Array = []",
      "    let w = makers[0]()",
      "    let v = foo(1).Bar()",
      "  }",
      "}",
    ].join("\n");
    const chunks = [
      { symbolId: "Svc", startLine: 1, endLine: 7, scope: [] },
      { symbolId: "Svc#run", startLine: 2, endLine: 6, scope: ["Svc"] },
    ];
    const owner = { ownerSymbolId: "Svc#run" };
    expect(declarationsOf(src, chunks)).toEqual([
      { name: "xs", kind: "local", line: 3, ...owner, typeName: "Array", typeSource: "annotation" },
      { name: "w", kind: "local", line: 4, ...owner },
      { name: "v", kind: "local", line: 5, ...owner, boundCallee: { member: "Bar", receiver: "foo(1)" } },
    ]);
  });
});
