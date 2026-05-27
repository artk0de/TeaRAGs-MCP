import Parser from "tree-sitter";
import GoLang from "tree-sitter-go";
import { describe, it, expect, beforeAll } from "vitest";

import { goSymbolOf } from "../../../../../src/core/domains/language/go/naming.js";

let parser: Parser;
beforeAll(() => {
  parser = new Parser();
  parser.setLanguage(GoLang as Parser.Language);
});

function firstOfType(code: string, type: string): Parser.SyntaxNode {
  const root = parser.parse(code).rootNode;
  const found = (function walk(n: Parser.SyntaxNode): Parser.SyntaxNode | null {
    if (n.type === type) return n;
    for (const c of n.children) {
      const r = walk(c);
      if (r) return r;
    }
    return null;
  })(root);
  if (!found) throw new Error(`no ${type} in: ${code}`);
  return found;
}

describe("goSymbolOf", () => {
  it("composes Receiver#Method for a pointer-receiver method", () => {
    const node = firstOfType("func (c *Context) Query(k string) string { return \"\" }", "method_declaration");
    expect(goSymbolOf(node)).toEqual({ name: "Context#Query", symbolId: "Context#Query", instanceMethod: true });
  });
  it("emits the bare type name for a struct type_declaration", () => {
    const node = firstOfType("type Engine struct { n int }", "type_declaration");
    expect(goSymbolOf(node)).toEqual({ name: "Engine", symbolId: "Engine", instanceMethod: false });
  });
  it("emits the bare type name for a type_alias (type Foo = Bar) — chunker/codegraph lockstep", () => {
    // The former goNameOf matched only type_spec, dropping aliases the chunker
    // already emitted; goSymbolOf matches type_alias too so both agree.
    const node = firstOfType("type Handler = func()", "type_declaration");
    expect(goSymbolOf(node)).toEqual({ name: "Handler", symbolId: "Handler", instanceMethod: false });
  });
  it("emits the bare name for a top-level function_declaration", () => {
    const node = firstOfType("func New() *Engine { return nil }", "function_declaration");
    expect(goSymbolOf(node)).toEqual({ name: "New", symbolId: "New", instanceMethod: false });
  });
  it("returns null for a non-symbol node", () => {
    const node = firstOfType("package main", "package_clause");
    expect(goSymbolOf(node)).toBeNull();
  });
});
