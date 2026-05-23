/**
 * Go chunker hook symbol resolver tests — pin the chunker-side symbolId
 * emission for Go method/type nodes. Mirrors the codegraph provider's
 * `goNameOf` (bd tea-rags-mcp-n7x5, tea-rags-mcp-j2b7).
 *
 * Convention per `.claude/rules/symbolid-convention.md`:
 *
 *   method_declaration → `Receiver#Method`
 *   type_declaration   → `TypeName` (top-level type alias)
 *
 * Pointer (`*Receiver`) strips to bare `Receiver`. Generic-receiver
 * (`Receiver[T]`) drops the type-parameter list.
 */

import Parser from "tree-sitter";
import GoLang from "tree-sitter-go";
import { describe, expect, it } from "vitest";

import { extractGoSymbol } from "../../../../../../../../src/core/domains/ingest/pipeline/chunker/hooks/go/symbol-resolver.js";

function parse(src: string): Parser.Tree {
  const p = new Parser();
  p.setLanguage(GoLang as unknown as Parser.Language);
  return p.parse(src);
}

function nodeOf(src: string, type: string): Parser.SyntaxNode {
  const tree = parse(src);
  const node = tree.rootNode.descendantsOfType(type)[0];
  if (!node) throw new Error(`No ${type} found in:\n${src}`);
  return node;
}

describe("extractGoSymbol — method_declaration", () => {
  it("value receiver: func (r Receiver) Method() → 'Receiver#Method'", () => {
    const node = nodeOf("package p\nfunc (r Receiver) Method() {}\n", "method_declaration");
    expect(extractGoSymbol(node)).toEqual({ name: "Receiver#Method", symbolId: "Receiver#Method" });
  });

  it("pointer receiver: func (r *Receiver) Method() → 'Receiver#Method' (* stripped)", () => {
    const node = nodeOf("package p\nfunc (r *Receiver) Method() {}\n", "method_declaration");
    expect(extractGoSymbol(node)).toEqual({ name: "Receiver#Method", symbolId: "Receiver#Method" });
  });

  it("generic receiver: func (r Box[T]) Get() → 'Box#Get' (type-params dropped)", () => {
    const node = nodeOf("package p\nfunc (r Box[T]) Get() {}\n", "method_declaration");
    expect(extractGoSymbol(node)).toEqual({ name: "Box#Get", symbolId: "Box#Get" });
  });

  it("generic receiver with multiple type params: func (r Box[K, V]) Pair() → 'Box#Pair'", () => {
    const node = nodeOf("package p\nfunc (r Box[K, V]) Pair() {}\n", "method_declaration");
    expect(extractGoSymbol(node)).toEqual({ name: "Box#Pair", symbolId: "Box#Pair" });
  });
});

describe("extractGoSymbol — type_declaration", () => {
  it("struct: type Foo struct {} → 'Foo'", () => {
    const node = nodeOf("package p\ntype Foo struct{}\n", "type_declaration");
    expect(extractGoSymbol(node)).toEqual({ name: "Foo", symbolId: "Foo" });
  });

  it("interface: type Bar interface{} → 'Bar'", () => {
    const node = nodeOf("package p\ntype Bar interface{}\n", "type_declaration");
    expect(extractGoSymbol(node)).toEqual({ name: "Bar", symbolId: "Bar" });
  });

  it("type alias: type Quux func() → 'Quux'", () => {
    const node = nodeOf("package p\ntype Quux func()\n", "type_declaration");
    expect(extractGoSymbol(node)).toEqual({ name: "Quux", symbolId: "Quux" });
  });

  it("slice alias: type Strings []string → 'Strings'", () => {
    const node = nodeOf("package p\ntype Strings []string\n", "type_declaration");
    expect(extractGoSymbol(node)).toEqual({ name: "Strings", symbolId: "Strings" });
  });

  it("map alias: type Counts map[string]int → 'Counts'", () => {
    const node = nodeOf("package p\ntype Counts map[string]int\n", "type_declaration");
    expect(extractGoSymbol(node)).toEqual({ name: "Counts", symbolId: "Counts" });
  });
});

describe("extractGoSymbol — fall-through", () => {
  it("returns null for top-level function_declaration (caller falls back to default name extraction)", () => {
    const node = nodeOf("package p\nfunc Foo() {}\n", "function_declaration");
    expect(extractGoSymbol(node)).toBeNull();
  });

  it("returns null for an unrelated node type (e.g. const_declaration)", () => {
    const tree = parse("package p\nconst x = 1\n");
    const decl = tree.rootNode.descendantsOfType("const_declaration")[0];
    expect(decl).toBeDefined();
    expect(extractGoSymbol(decl)).toBeNull();
  });
});
