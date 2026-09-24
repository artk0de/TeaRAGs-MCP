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

/** Through the COMPOSED walker, so the pass is exercised where production runs it. */
function declarationsOf(src: string, chunks: WalkInput["chunks"]) {
  return new GoLanguage().walker.walk({ tree: parse(src), code: src, relPath: "svc.go", language: "go", chunks })
    .identifierDeclarations;
}

// bd tea-rags-mcp-4p3sb.5 — the naming lexicon's syntactic half for Go.
describe("Go walker — identifier declarations", () => {
  it("records struct fields per name; pointers and slices unwrap to the element type", () => {
    const src = [
      "package p",
      "type Svc struct {",
      "\trepo *Repo",
      "\ta, b []Item",
      "\tcache map[string]int",
      "\tpool sync.Pool",
      "\tBase",
      "}",
    ].join("\n");
    const chunks = [{ symbolId: "Svc", startLine: 2, endLine: 8, scope: [] }];
    expect(declarationsOf(src, chunks)).toEqual([
      { name: "repo", kind: "field", line: 3, ownerSymbolId: "Svc", typeName: "Repo", typeSource: "annotation" },
      { name: "a", kind: "field", line: 4, ownerSymbolId: "Svc", typeName: "Item", typeSource: "annotation" },
      { name: "b", kind: "field", line: 4, ownerSymbolId: "Svc", typeName: "Item", typeSource: "annotation" },
      { name: "cache", kind: "field", line: 5, ownerSymbolId: "Svc" },
      { name: "pool", kind: "field", line: 6, ownerSymbolId: "Svc", typeName: "sync.Pool", typeSource: "annotation" },
    ]);
  });

  it("records grouped and variadic params, short and var locals; the receiver and `New<X>()` stay out / untyped", () => {
    const src = [
      "package p",
      "func (s *Svc) Load(id string, xs []*Doc, n, m int, opts ...Option) {",
      "\tdoc := &Document{}",
      "\trow, err := s.repo.Get(id)",
      "\tvar cfg Config",
      "\tvar q, r = pkg.Queue{}, 2",
      "\tw := NewWidget()",
      "\tg := List[int]{}",
      "\tfor i, v := range xs {",
      "\t}",
      "\tf := func(k Key) {}",
      "\tdoc = nil",
      "}",
    ].join("\n");
    const chunks = [{ symbolId: "Svc#Load", startLine: 2, endLine: 13, scope: ["Svc"] }];
    const owner = { ownerSymbolId: "Svc#Load" };
    expect(declarationsOf(src, chunks)).toEqual([
      { name: "id", kind: "param", line: 2, ...owner, typeName: "string", typeSource: "annotation" },
      { name: "xs", kind: "param", line: 2, ...owner, typeName: "Doc", typeSource: "annotation" },
      { name: "n", kind: "param", line: 2, ...owner, typeName: "int", typeSource: "annotation" },
      { name: "m", kind: "param", line: 2, ...owner, typeName: "int", typeSource: "annotation" },
      { name: "opts", kind: "param", line: 2, ...owner, typeName: "Option", typeSource: "annotation" },
      { name: "doc", kind: "local", line: 3, ...owner, typeName: "Document", typeSource: "constructor" },
      { name: "row", kind: "local", line: 4, ...owner },
      { name: "err", kind: "local", line: 4, ...owner },
      { name: "cfg", kind: "local", line: 5, ...owner, typeName: "Config", typeSource: "annotation" },
      { name: "q", kind: "local", line: 6, ...owner, typeName: "pkg.Queue", typeSource: "constructor" },
      { name: "r", kind: "local", line: 6, ...owner },
      { name: "w", kind: "local", line: 7, ...owner },
      { name: "g", kind: "local", line: 8, ...owner, typeName: "List", typeSource: "constructor" },
      { name: "i", kind: "local", line: 9, ...owner },
      { name: "v", kind: "local", line: 9, ...owner },
      { name: "f", kind: "local", line: 11, ...owner },
      { name: "k", kind: "param", line: 11, ...owner, typeName: "Key", typeSource: "annotation" },
    ]);
  });
});
