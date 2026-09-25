import Parser from "tree-sitter";
import RustLang from "tree-sitter-rust";
import { describe, expect, it } from "vitest";

import type { WalkInput } from "../../../../../../src/core/contracts/types/language.js";
import { RustLanguage } from "../../../../../../src/core/domains/language/rust/index.js";

function parse(src: string) {
  const p = new Parser();
  p.setLanguage(RustLang);
  return p.parse(src);
}

function declarationsOf(src: string, chunks: WalkInput["chunks"]) {
  return new RustLanguage().walker.walk({ tree: parse(src), code: src, relPath: "svc.rs", language: "rust", chunks })
    .identifierDeclarations;
}

// bd tea-rags-mcp-4p3sb.5 — shapes that declare a name but name no type.
describe("Rust walker — identifier declarations that carry no type", () => {
  it("a fixed array, a literal inside a pattern and a qualified-path constructor declare names without a type", () => {
    const src = [
      "impl Svc {",
      "    fn run(&self, buf: [u8; 4]) {",
      "        let (p, 0) = pair;",
      "        let x = <Svc as Default>::new();",
      "    }",
      "}",
    ].join("\n");
    const chunks = [
      { symbolId: "Svc", startLine: 1, endLine: 6, scope: [] },
      { symbolId: "Svc#run", startLine: 2, endLine: 5, scope: ["Svc"] },
    ];
    const owner = { ownerSymbolId: "Svc#run" };
    expect(declarationsOf(src, chunks)).toEqual([
      { name: "buf", kind: "param", line: 2, ...owner },
      { name: "p", kind: "local", line: 3, ...owner },
      { name: "x", kind: "local", line: 4, ...owner, boundCallee: { member: "new", receiver: "<Svc as Default>" } },
    ]);
  });
});
