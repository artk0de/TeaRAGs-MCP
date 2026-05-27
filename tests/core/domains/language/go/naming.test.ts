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
  // Ported from the removed chunker hooks/go/symbol-resolver.test.ts
  // (extractGoSymbol corner cases) — goSymbolOf now owns receiver/type naming.
  it("composes Receiver#Method for a value-receiver method", () => {
    const node = firstOfType("func (r Receiver) Method() {}", "method_declaration");
    expect(goSymbolOf(node)).toEqual({ name: "Receiver#Method", symbolId: "Receiver#Method", instanceMethod: true });
  });
  it("drops type-params on a generic receiver: func (r Box[T]) Get() → Box#Get", () => {
    const node = firstOfType("func (r Box[T]) Get() {}", "method_declaration");
    expect(goSymbolOf(node)).toEqual({ name: "Box#Get", symbolId: "Box#Get", instanceMethod: true });
  });
  it("drops multiple type-params on a generic receiver: func (r Box[K, V]) Pair() → Box#Pair", () => {
    const node = firstOfType("func (r Box[K, V]) Pair() {}", "method_declaration");
    expect(goSymbolOf(node)).toEqual({ name: "Box#Pair", symbolId: "Box#Pair", instanceMethod: true });
  });
  it("emits the bare type name for a struct type_declaration", () => {
    const node = firstOfType("type Engine struct { n int }", "type_declaration");
    expect(goSymbolOf(node)).toEqual({ name: "Engine", symbolId: "Engine", instanceMethod: false });
  });
  it("emits the bare type name for an interface type_declaration", () => {
    const node = firstOfType("type Bar interface{}", "type_declaration");
    expect(goSymbolOf(node)).toEqual({ name: "Bar", symbolId: "Bar", instanceMethod: false });
  });
  it("emits the bare name for a func defined-type: type Quux func() → Quux", () => {
    const node = firstOfType("type Quux func()", "type_declaration");
    expect(goSymbolOf(node)).toEqual({ name: "Quux", symbolId: "Quux", instanceMethod: false });
  });
  it("emits the bare name for a slice defined-type: type Strings []string → Strings", () => {
    const node = firstOfType("type Strings []string", "type_declaration");
    expect(goSymbolOf(node)).toEqual({ name: "Strings", symbolId: "Strings", instanceMethod: false });
  });
  it("emits the bare name for a map defined-type: type Counts map[string]int → Counts", () => {
    const node = firstOfType("type Counts map[string]int", "type_declaration");
    expect(goSymbolOf(node)).toEqual({ name: "Counts", symbolId: "Counts", instanceMethod: false });
  });
  it("returns null for an unrelated node type (const_declaration)", () => {
    const node = firstOfType("const x = 1", "const_declaration");
    expect(goSymbolOf(node)).toBeNull();
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
