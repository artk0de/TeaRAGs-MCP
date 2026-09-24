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

/** Through the COMPOSED walker, so the pass is exercised where production runs it. */
function declarationsOf(src: string, chunks: WalkInput["chunks"]) {
  return new RustLanguage().walker.walk({ tree: parse(src), code: src, relPath: "svc.rs", language: "rust", chunks })
    .identifierDeclarations;
}

// bd tea-rags-mcp-4p3sb.5 — the naming lexicon's syntactic half for Rust.
describe("Rust walker — identifier declarations", () => {
  it("records struct fields; references, lifetimes and generic args are stripped", () => {
    const src = [
      "struct Svc {",
      "    repo: Repo,",
      "    cache: Vec<Item>,",
      "    db: &'static mut Db,",
      "    pair: (u8, u8),",
      "}",
    ].join("\n");
    const chunks = [{ symbolId: "Svc", startLine: 1, endLine: 6, scope: [] }];
    expect(declarationsOf(src, chunks)).toEqual([
      { name: "repo", kind: "field", line: 2, ownerSymbolId: "Svc", typeName: "Repo", typeSource: "annotation" },
      { name: "cache", kind: "field", line: 3, ownerSymbolId: "Svc", typeName: "Vec", typeSource: "annotation" },
      { name: "db", kind: "field", line: 4, ownerSymbolId: "Svc", typeName: "Db", typeSource: "annotation" },
      { name: "pair", kind: "field", line: 5, ownerSymbolId: "Svc" },
    ]);
  });

  it("records params and let locals; struct literals and `X::new` type by constructor", () => {
    const src = [
      "impl Svc {",
      "    fn load(&self, id: &str, mut xs: Vec<Doc>, (a, b): (i32, i32), pool: std::sync::Pool) {",
      "        let doc = Document { id: 1 };",
      "        let row = self.repo.get(id);",
      "        let cfg: Config = Config::new();",
      "        let mut w = Widget::new();",
      "        let g = crate::ui::Panel::new(1);",
      "        let d = Default::default();",
      "        let (p, q) = (1, 2);",
      "        let r = &mut Rc::new(3);",
      "        let f = |k: Key, z| k;",
      "        let s = Wrapper::<u8>::new();",
      "    }",
      "}",
    ].join("\n");
    const chunks = [
      { symbolId: "Svc", startLine: 1, endLine: 14, scope: [] },
      { symbolId: "Svc#load", startLine: 2, endLine: 13, scope: ["Svc"] },
    ];
    const owner = { ownerSymbolId: "Svc#load" };
    expect(declarationsOf(src, chunks)).toEqual([
      { name: "id", kind: "param", line: 2, ...owner, typeName: "str", typeSource: "annotation" },
      { name: "xs", kind: "param", line: 2, ...owner, typeName: "Vec", typeSource: "annotation" },
      { name: "a", kind: "param", line: 2, ...owner },
      { name: "b", kind: "param", line: 2, ...owner },
      { name: "pool", kind: "param", line: 2, ...owner, typeName: "std::sync::Pool", typeSource: "annotation" },
      { name: "doc", kind: "local", line: 3, ...owner, typeName: "Document", typeSource: "constructor" },
      { name: "row", kind: "local", line: 4, ...owner },
      { name: "cfg", kind: "local", line: 5, ...owner, typeName: "Config", typeSource: "annotation" },
      { name: "w", kind: "local", line: 6, ...owner, typeName: "Widget", typeSource: "constructor" },
      { name: "g", kind: "local", line: 7, ...owner, typeName: "crate::ui::Panel", typeSource: "constructor" },
      { name: "d", kind: "local", line: 8, ...owner },
      { name: "p", kind: "local", line: 9, ...owner },
      { name: "q", kind: "local", line: 9, ...owner },
      { name: "r", kind: "local", line: 10, ...owner, typeName: "Rc", typeSource: "constructor" },
      { name: "f", kind: "local", line: 11, ...owner },
      { name: "k", kind: "param", line: 11, ...owner, typeName: "Key", typeSource: "annotation" },
      { name: "z", kind: "param", line: 11, ...owner },
      { name: "s", kind: "local", line: 12, ...owner, typeName: "Wrapper", typeSource: "constructor" },
    ]);
  });
});
