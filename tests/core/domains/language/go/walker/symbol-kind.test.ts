/**
 * Go walker symbol kinds (tea-rags-mcp-vi0wx): every chunk the walker emits
 * carries the declaration kind of the node that named it. A struct is a class,
 * an interface an interface, a defined type over a non-struct (`type ID int`)
 * a class too — it can carry methods; only a true alias (`type X = Y`) is a
 * type_alias. A func is a function, a method with a receiver a method.
 */
import Parser from "tree-sitter";
import GoLang from "tree-sitter-go";
import { describe, expect, it } from "vitest";

import { GoLanguage } from "../../../../../../src/core/domains/language/go/index.js";
import { symbolKindOf } from "../../../../../../src/core/domains/language/go/walker/symbol-kind.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { materializeTree } from "../../../../../../src/core/infra/materialize.js";

/** `symbolId → symbolKind` through the seam production runs (materialize, `collectSymbols`, `walker.walk`). */
function symbolKindsOf(src: string): Record<string, string | undefined> {
  const language = new GoLanguage();
  const parser = new Parser();
  parser.setLanguage(GoLang);
  const rootNode = materializeTree(parser.parse(src).rootNode, src);
  const tree = { rootNode };
  const chunks = collectSymbols(
    tree,
    (node) => language.walker.nameOf(node),
    language.kernel.scopeSeparator ?? ".",
    language.kernel.disambiguateOverloads ?? false,
    new DefaultSymbolIdComposer(),
  );
  const extraction = language.walker.walk({ tree, code: src, relPath: "pkg/a.go", language: "go", chunks });
  return Object.fromEntries(extraction.chunks.map((c) => [c.symbolId, c.symbolKind]));
}

describe("Go walker — symbol kind per chunk", () => {
  it("tags structs, interfaces, defined types, aliases, functions and methods", () => {
    const src = [
      "package pkg",
      "const X = 1",
      "type S struct{ n int }",
      "type I interface{ Get() int }",
      "type ID int",
      "type Handler func(int) error",
      "type Alias = S",
      "func f() {}",
      "func (s *S) Get() int { return s.n }",
      'func (id ID) String() string { return "" }',
      "",
    ].join("\n");

    expect(symbolKindsOf(src)).toEqual({
      S: "class",
      I: "interface",
      ID: "class",
      Handler: "class",
      Alias: "type_alias",
      f: "function",
      "S#Get": "method",
      "ID#String": "method",
    });
  });

  it("tags each spec of a grouped type declaration on its own", () => {
    const src = [
      "package pkg",
      "type (",
      "\tReader interface{ Read() error }",
      "\tRow struct{}",
      "\tKey = string",
      ")",
      "",
    ].join("\n");

    expect(symbolKindsOf(src)).toEqual({ Reader: "interface", Row: "class", Key: "type_alias" });
  });

  it("tags two specs sharing one line by their own names", () => {
    const src = ["package pkg", "type ( A struct{}; B = A )", ""].join("\n");

    expect(symbolKindsOf(src)).toEqual({ A: "class", B: "type_alias" });
  });
});

describe("symbolKindOf", () => {
  it("maps Go declaration node types onto symbol kinds", () => {
    expect(symbolKindOf("function_declaration")).toBe("function");
    expect(symbolKindOf("method_declaration")).toBe("method");
    expect(symbolKindOf("type_spec", { typeBody: "struct_type" })).toBe("class");
    expect(symbolKindOf("type_spec", { typeBody: "interface_type" })).toBe("interface");
    expect(symbolKindOf("type_spec", { typeBody: "type_identifier" })).toBe("class");
    expect(symbolKindOf("type_spec", { typeBody: "function_type" })).toBe("class");
    expect(symbolKindOf("type_spec")).toBe("class");
    expect(symbolKindOf("type_alias")).toBe("type_alias");
  });

  it("answers undefined for nodes that declare no symbol", () => {
    expect(symbolKindOf("const_declaration")).toBeUndefined();
    expect(symbolKindOf("type_declaration")).toBeUndefined();
    expect(symbolKindOf("call_expression")).toBeUndefined();
  });
});
