/**
 * Rust walker symbol kinds (tea-rags-mcp-vi0wx): every chunk the walker emits
 * carries the declaration kind of the node that named it. A struct is a class,
 * an enum an enum, a trait an interface, a `mod` a module; a free `fn` is a
 * function, a `fn` in an `impl` or `trait` body a method. An `impl` block
 * declares nothing, so a chunk it names carries no kind.
 */
import Parser from "tree-sitter";
import RustLang from "tree-sitter-rust";
import { describe, expect, it } from "vitest";

import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { RustLanguage } from "../../../../../../src/core/domains/language/rust/index.js";
import { symbolKindOf } from "../../../../../../src/core/domains/language/rust/walker/symbol-kind.js";
import { materializeTree } from "../../../../../../src/core/infra/materialize.js";

/** `symbolId → symbolKind` through the seam production runs (materialize, `collectSymbols`, `walker.walk`). */
function symbolKindsOf(src: string): Record<string, string | undefined> {
  const language = new RustLanguage();
  const parser = new Parser();
  parser.setLanguage(RustLang);
  const rootNode = materializeTree(parser.parse(src).rootNode, src);
  const tree = { rootNode };
  const chunks = collectSymbols(
    tree,
    (node) => language.walker.nameOf(node),
    language.kernel.scopeSeparator ?? ".",
    language.kernel.disambiguateOverloads ?? false,
    new DefaultSymbolIdComposer(),
  );
  const extraction = language.walker.walk({ tree, code: src, relPath: "src/a.rs", language: "rust", chunks });
  return Object.fromEntries(extraction.chunks.map((c) => [c.symbolId, c.symbolKind]));
}

describe("Rust walker — symbol kind per chunk", () => {
  it("tags structs, enums, traits, modules, free functions and methods", () => {
    const src = [
      "pub struct Engine { n: i32 }",
      "enum Kind { A, B }",
      "trait Store {",
      "    fn get(&self) -> i32 { 1 }",
      "    fn make() -> Self;",
      "}",
      "impl Engine {",
      "    fn new() -> Self { Engine { n: 0 } }",
      "    fn run(&self) -> i32 { self.n }",
      "}",
      "mod inner {",
      "    fn helper() {}",
      "    struct Local;",
      "}",
      "fn free() {",
      "    fn nested() {}",
      "}",
      "",
    ].join("\n");

    expect(symbolKindsOf(src)).toEqual({
      Engine: "class",
      Kind: "enum",
      Store: "interface",
      "Store#get": "method",
      "Engine.new": "method",
      "Engine#run": "method",
      inner: "module",
      "inner.helper": "function",
      "inner::Local": "class",
      free: "function",
      "free.nested": "function",
    });
  });

  it("leaves a chunk an impl block names untagged when no type declaration precedes it", () => {
    const src = ["impl Remote {", "    fn go(&self) {}", "}", ""].join("\n");

    expect(symbolKindsOf(src)).toEqual({ Remote: undefined, "Remote#go": "method" });
  });

  it("tags a type by its declaration when struct and impl share one line", () => {
    expect(symbolKindsOf("struct Unit; impl Unit { fn f(&self) {} }\n")).toEqual({
      Unit: "class",
      "Unit#f": "method",
    });
  });

  it("tells a module from a same-named item it contains on the same line", () => {
    expect(symbolKindsOf("mod Foo { pub struct Foo; }\n")).toEqual({ Foo: "module", "Foo::Foo": "class" });
  });

  it("emits no chunk for const, static or type alias items (not symbols: they would steal top-level call sites)", () => {
    const src = [
      "const MAX: u32 = limit();",
      'static NAME: &str = "x";',
      "type Id = u64;",
      "fn limit() -> u32 { 3 }",
      "",
    ].join("\n");

    expect(symbolKindsOf(src)).toEqual({ limit: "function" });
  });
});

describe("symbolKindOf (Rust)", () => {
  it.each([
    ["struct_item", {}, "class"],
    ["union_item", {}, "class"],
    ["enum_item", {}, "enum"],
    ["trait_item", {}, "interface"],
    ["mod_item", {}, "module"],
    ["const_item", {}, "constant"],
    ["static_item", {}, "constant"],
    ["type_item", {}, "type_alias"],
    ["function_item", {}, "function"],
    ["function_item", { ownerItem: "mod_item" }, "function"],
    ["function_item", { ownerItem: "impl_item" }, "method"],
    ["function_item", { ownerItem: "trait_item" }, "method"],
    ["impl_item", {}, undefined],
    ["macro_definition", {}, undefined],
  ] as const)("%s %o → %s", (nodeType, context, expected) => {
    expect(symbolKindOf(nodeType, context)).toBe(expected);
  });
});
