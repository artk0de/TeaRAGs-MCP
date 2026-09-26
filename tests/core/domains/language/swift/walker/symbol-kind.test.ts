/**
 * Swift walker symbol kinds (tea-rags-mcp-vi0wx): every chunk the walker emits
 * carries the declaration kind of the node that named it. A class, struct or
 * actor is a class, a protocol an interface, an enum an enum. A `func` at file
 * scope is a function; a `func` or `init` inside a type, an extension or a
 * protocol is a method. An extension re-opens a type declared elsewhere and is
 * given no kind of its own.
 */
import Parser from "tree-sitter";
import SwiftLang from "tree-sitter-swift";
import { describe, expect, it } from "vitest";

import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { SwiftLanguage } from "../../../../../../src/core/domains/language/swift/index.js";
import { symbolKindOf } from "../../../../../../src/core/domains/language/swift/walker/symbol-kind.js";
import { materializeTree } from "../../../../../../src/core/infra/materialize.js";

const grammar = ((SwiftLang as { default?: unknown }).default ?? SwiftLang) as Parser.Language;

/** `symbolId → symbolKind` through the seam production runs (materialize, `collectSymbols`, `walker.walk`). */
function symbolKindsOf(src: string): Record<string, string | undefined> {
  const language = new SwiftLanguage();
  const parser = new Parser();
  parser.setLanguage(grammar);
  const rootNode = materializeTree(parser.parse(src).rootNode, src);
  const tree = { rootNode };
  const chunks = collectSymbols(
    tree,
    (node) => language.walker.nameOf(node),
    language.kernel.scopeSeparator ?? ".",
    language.kernel.disambiguateOverloads ?? false,
    new DefaultSymbolIdComposer(),
  );
  const extraction = language.walker.walk({ tree, code: src, relPath: "Sources/A.swift", language: "swift", chunks });
  return Object.fromEntries(extraction.chunks.map((c) => [c.symbolId, c.symbolKind]));
}

describe("Swift walker — symbol kind per chunk", () => {
  it("tags types, protocols, enums, functions and methods", () => {
    const src = [
      "class Invoice {",
      "    init() {}",
      "    func total() -> Int { 0 }",
      "    static func make() -> Invoice { Invoice() }",
      "}",
      "struct Line {",
      "    func amount() -> Int { 0 }",
      "}",
      "actor Ledger {}",
      "protocol Billable {",
      "    func bill()",
      "}",
      "enum Status {",
      "    case open",
      '    func label() -> String { "" }',
      "}",
      "typealias Amount = Int",
      "func helper() {}",
      "",
    ].join("\n");

    expect(symbolKindsOf(src)).toEqual({
      Invoice: "class",
      "Invoice#init": "method",
      "Invoice#total": "method",
      "Invoice.make": "method",
      Line: "class",
      "Line#amount": "method",
      Ledger: "class",
      Billable: "interface",
      "Billable#bill": "method",
      Status: "enum",
      "Status#label": "method",
      helper: "function",
    });
  });

  it("gives an extension no kind and tags its members as methods", () => {
    const src = ["extension Invoice {", "    func tax() -> Int { 0 }", "}", ""].join("\n");

    expect(symbolKindsOf(src)).toEqual({ Invoice: undefined, "Invoice#tax": "method" });
  });

  it("tells two declarations sharing one line apart by name", () => {
    const src = ["struct Box { func open() {} }", ""].join("\n");

    expect(symbolKindsOf(src)).toEqual({ Box: "class", "Box#open": "method" });
  });

  it("tags a function in a type nested in a type as a method", () => {
    const src = ["enum Outer {", "    struct Inner {", "        func run() {}", "    }", "}", ""].join("\n");

    expect(symbolKindsOf(src)).toEqual({ Outer: "enum", "Outer.Inner": "class", "Outer.Inner#run": "method" });
  });
});

describe("symbolKindOf", () => {
  it("maps each type keyword", () => {
    expect(symbolKindOf("class_declaration", { atTopLevel: true, typeKeyword: "class" })).toBe("class");
    expect(symbolKindOf("class_declaration", { atTopLevel: true, typeKeyword: "struct" })).toBe("class");
    expect(symbolKindOf("class_declaration", { atTopLevel: true, typeKeyword: "actor" })).toBe("class");
    expect(symbolKindOf("class_declaration", { atTopLevel: true, typeKeyword: "enum" })).toBe("enum");
    expect(symbolKindOf("class_declaration", { atTopLevel: true, typeKeyword: "extension" })).toBeUndefined();
    expect(symbolKindOf("class_declaration", { atTopLevel: true })).toBeUndefined();
    expect(symbolKindOf("protocol_declaration", { atTopLevel: true })).toBe("interface");
  });

  it("maps callables by position", () => {
    expect(symbolKindOf("function_declaration", { atTopLevel: true })).toBe("function");
    expect(symbolKindOf("function_declaration", { atTopLevel: false })).toBe("method");
    expect(symbolKindOf("protocol_function_declaration", { atTopLevel: false })).toBe("method");
    expect(symbolKindOf("init_declaration", { atTopLevel: false })).toBe("method");
    expect(symbolKindOf("deinit_declaration", { atTopLevel: false })).toBe("method");
    expect(symbolKindOf("subscript_declaration", { atTopLevel: false })).toBe("method");
  });

  it("maps a typealias and declines anything else", () => {
    expect(symbolKindOf("typealias_declaration", { atTopLevel: true })).toBe("type_alias");
    expect(symbolKindOf("property_declaration", { atTopLevel: true })).toBeUndefined();
  });
});
