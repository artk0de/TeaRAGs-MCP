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

function declarationsOf(src: string, chunks: WalkInput["chunks"]) {
  return new JavaLanguage().walker.walk({ tree: parse(src), code: src, relPath: "Svc.java", language: "java", chunks })
    .identifierDeclarations;
}

// bd tea-rags-mcp-4p3sb.6 — shapes that declare a name but name no type.
describe("Java walker — identifier declarations that carry no type", () => {
  it("a parameterless lambda declares nothing; its enclosing local is still recorded", () => {
    const src = ["class Svc {", "  void run() {", "    Runnable r = () -> go();", "  }", "}"].join("\n");
    const chunks = [
      { symbolId: "Svc", startLine: 1, endLine: 5, scope: [] },
      { symbolId: "Svc#run", startLine: 2, endLine: 4, scope: ["Svc"] },
    ];
    expect(declarationsOf(src, chunks)).toEqual([
      { name: "r", kind: "local", line: 3, ownerSymbolId: "Svc#run", typeName: "Runnable", typeSource: "annotation" },
    ]);
  });
});
