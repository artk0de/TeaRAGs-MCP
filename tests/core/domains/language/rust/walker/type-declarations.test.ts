/**
 * Rust walker type/constant declaration facts (spec §1b, W3c): every walk
 * publishes `FileExtraction.typeDeclarations` — one fact per struct / union
 * (class), enum, trait (interface, `conforms` = its supertraits), `type X = …`
 * (type_alias), `const` / `static` (constant) and `mod name { … }` (module).
 * A declaration nested in a `mod`, a trait or an `impl` block carries the
 * nesting in its typeId, composed with `::` as the chunk ids are
 * (`inner::Local`). Declarations local to a function body are not facts, and
 * `impl Trait for S` is not a supertype of `S`.
 */
import Parser from "tree-sitter";
import RustLang from "tree-sitter-rust";
import { describe, expect, it } from "vitest";

import type { FileExtraction } from "../../../../../../src/core/contracts/types/codegraph.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { RustLanguage } from "../../../../../../src/core/domains/language/rust/index.js";
import { materializeTree } from "../../../../../../src/core/infra/materialize.js";

/** Walk `src` through the seam production runs (materialize, `collectSymbols`, `walker.walk`). */
function extract(src: string): FileExtraction {
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
  return language.walker.walk({ tree, code: src, relPath: "src/a.rs", language: "rust", chunks });
}

describe("Rust walker — type declaration facts", () => {
  it("publishes structs, unions, enums, traits, type aliases, consts, statics and inline modules with their kinds", () => {
    const src = [
      "pub struct Engine { n: i32 }",
      "union Bits { a: u32, b: f32 }",
      "enum Kind { A, B }",
      "trait Store { fn get(&self) -> i32; }",
      "type Map<T> = Vec<T>;",
      "pub const MAX: u32 = 10;",
      "static mut COUNTER: i32 = 0;",
      "mod inner { }",
      "",
    ].join("\n");

    expect(extract(src).typeDeclarations).toEqual([
      { typeId: "Engine", symbolKind: "class", line: 1, reopens: false },
      { typeId: "Bits", symbolKind: "class", line: 2, reopens: false },
      { typeId: "Kind", symbolKind: "enum", line: 3, reopens: false },
      { typeId: "Store", symbolKind: "interface", line: 4, reopens: false },
      { typeId: "Map", symbolKind: "type_alias", line: 5, reopens: false },
      { typeId: "MAX", symbolKind: "constant", line: 6, reopens: false },
      { typeId: "COUNTER", symbolKind: "constant", line: 7, reopens: false },
      { typeId: "inner", symbolKind: "module", line: 8, reopens: false },
    ]);
  });

  it("composes a declaration nested in a mod with `::`, the way its chunk id is composed", () => {
    const src = [
      "mod outer {",
      "    pub struct Local;",
      "    const LIMIT: usize = 3;",
      "    pub mod deep {",
      "        pub enum Mode { On }",
      "        pub type Id = u64;",
      "    }",
      "}",
      "",
    ].join("\n");

    expect(extract(src).typeDeclarations).toEqual([
      { typeId: "outer", symbolKind: "module", line: 1, reopens: false },
      { typeId: "outer::Local", symbolKind: "class", line: 2, reopens: false },
      { typeId: "outer::LIMIT", symbolKind: "constant", line: 3, reopens: false },
      { typeId: "outer::deep", symbolKind: "module", line: 4, reopens: false },
      { typeId: "outer::deep::Mode", symbolKind: "enum", line: 5, reopens: false },
      { typeId: "outer::deep::Id", symbolKind: "type_alias", line: 6, reopens: false },
    ]);
  });

  it("nests associated consts under the trait or the implementing type", () => {
    const src = [
      "trait Limits {",
      "    const CAP: usize;",
      "    const FLOOR: usize = 0;",
      "}",
      "struct Pool;",
      "impl Pool {",
      "    pub const SIZE: usize = 8;",
      "}",
      "impl<T> Limits for Wrapper<T> {",
      "    const CAP: usize = 4;",
      "}",
      "",
    ].join("\n");

    expect(extract(src).typeDeclarations).toEqual([
      { typeId: "Limits", symbolKind: "interface", line: 1, reopens: false },
      { typeId: "Limits::CAP", symbolKind: "constant", line: 2, reopens: false },
      { typeId: "Limits::FLOOR", symbolKind: "constant", line: 3, reopens: false },
      { typeId: "Pool", symbolKind: "class", line: 5, reopens: false },
      { typeId: "Pool::SIZE", symbolKind: "constant", line: 7, reopens: false },
      { typeId: "Wrapper::CAP", symbolKind: "constant", line: 10, reopens: false },
    ]);
  });

  it("lists supertraits as conforms, in clause order, generic arguments, lifetimes and ?Sized dropped", () => {
    const src = [
      "trait Service: Base + fmt::Debug + Handler<Req> + 'static + ?Sized + for<'a> Visit<'a> {}",
      "trait Plain {}",
      "",
    ].join("\n");

    expect(extract(src).typeDeclarations).toEqual([
      {
        typeId: "Service",
        symbolKind: "interface",
        line: 1,
        reopens: false,
        conforms: ["Base", "fmt::Debug", "Handler", "Visit"],
      },
      { typeId: "Plain", symbolKind: "interface", line: 2, reopens: false },
    ]);
  });

  it("gives a struct no conforms: `impl Trait for S` is not a supertype of the declaration", () => {
    const src = ["struct S;", "impl Clone for S { fn clone(&self) -> Self { S } }", ""].join("\n");

    expect(extract(src).typeDeclarations).toEqual([{ typeId: "S", symbolKind: "class", line: 1, reopens: false }]);
  });

  it("does not publish a trait-mandated associated type in an impl, nor a trait's associated type declaration", () => {
    const src = [
      "trait Source { type Item; }",
      "struct Counter;",
      "impl Iterator for Counter {",
      "    type Item = u32;",
      "    fn next(&mut self) -> Option<u32> { None }",
      "}",
      "",
    ].join("\n");

    expect(extract(src).typeDeclarations).toEqual([
      { typeId: "Source", symbolKind: "interface", line: 1, reopens: false },
      { typeId: "Counter", symbolKind: "class", line: 2, reopens: false },
    ]);
  });

  it("does not publish declarations local to a function, a method or a closure", () => {
    const src = [
      "const GLOBAL: u8 = 1;",
      "fn f() {",
      "    const LOCAL: u8 = 2;",
      "    static HIDDEN: u8 = 3;",
      "    struct Inner;",
      "    enum E { A }",
      "    type T = u8;",
      "    let _g = || { const DEEPER: u8 = 4; };",
      "}",
      "struct S;",
      "impl S { fn m(&self) { const IN_METHOD: u8 = 5; } }",
      "static TABLE: [u8; 1] = { const SEED: u8 = 6; [SEED] };",
      "",
    ].join("\n");

    expect(extract(src).typeDeclarations).toEqual([
      { typeId: "GLOBAL", symbolKind: "constant", line: 1, reopens: false },
      { typeId: "S", symbolKind: "class", line: 10, reopens: false },
      { typeId: "TABLE", symbolKind: "constant", line: 12, reopens: false },
    ]);
  });

  it("does not publish an out-of-line `mod name;` declaration", () => {
    expect(extract("mod other;\npub mod api;\n")).not.toHaveProperty("typeDeclarations");
  });

  it("omits the channel on a file that declares no type or constant", () => {
    expect(extract("fn f() {}\nimpl Remote { fn go(&self) {} }\n")).not.toHaveProperty("typeDeclarations");
  });
});

describe("Rust walker — type declaration facts leave the rest of the extraction unchanged", () => {
  // Pinned from the walker BEFORE the typeDeclarations channel existed: the
  // chunk set, symbol kinds, calls, bindings and imports must be byte-identical.
  const src = [
    "use std::fmt;",
    "",
    "pub const MAX: usize = compute();",
    "",
    "pub struct Engine { worker: Worker, n: i32 }",
    "",
    "pub trait Runner: fmt::Debug {",
    "    const LIMIT: u8 = 1;",
    "    fn run(&self) -> i32;",
    "}",
    "",
    "impl Engine {",
    "    pub const SIZE: usize = 2;",
    "    pub fn new() -> Self { Engine { worker: Worker::new(), n: 0 } }",
    "    fn go(&self, p: Worker) -> i32 {",
    "        let w = Worker::new();",
    "        w.start();",
    "        self.worker.tick();",
    '        println!("{}", p.id());',
    "        self.n",
    "    }",
    "}",
    "",
    "mod inner {",
    "    pub struct Local;",
    "    pub fn helper() { super::free(); }",
    "}",
    "",
    "fn free() {}",
    "",
  ].join("\n");

  it("keeps chunks, symbols, CallRefs, bindings and imports as they were", () => {
    const { typeDeclarations, ...rest } = extract(src);

    expect(typeDeclarations?.map((f) => f.typeId)).toEqual([
      "MAX",
      "Engine",
      "Runner",
      "Runner::LIMIT",
      "Engine::SIZE",
      "inner",
      "inner::Local",
    ]);
    expect(JSON.parse(JSON.stringify(rest))).toEqual(BASELINE_EXTRACTION);
  });
});

const BASELINE_EXTRACTION = {
  relPath: "src/a.rs",
  language: "rust",
  imports: [{ importText: "std::fmt", startLine: 1 }],
  chunks: [
    { symbolId: "Engine", scope: [], startLine: 5, endLine: 5, calls: [], symbolKind: "class", visibility: "public" },
    {
      symbolId: "Runner",
      scope: [],
      startLine: 7,
      endLine: 10,
      calls: [],
      symbolKind: "interface",
      visibility: "public",
    },
    {
      symbolId: "Engine.new",
      scope: ["Engine"],
      startLine: 14,
      endLine: 14,
      calls: [{ callText: "Worker::new()", receiver: "Worker", member: "new", startLine: 14 }],
      symbolKind: "method",
      visibility: "public",
    },
    {
      symbolId: "Engine#go",
      scope: ["Engine"],
      startLine: 15,
      endLine: 21,
      calls: [
        { callText: "Worker::new()", receiver: "Worker", member: "new", startLine: 16 },
        { callText: "w.start()", receiver: "w", member: "start", startLine: 17 },
        { callText: "self.worker.tick()", receiver: "self.worker", member: "tick", startLine: 18 },
        { callText: 'println!("{}", p.id())', receiver: null, member: "println", startLine: 19 },
      ],
      symbolKind: "method",
      localBindings: { p: [{ line: 15, type: "Worker" }], w: [{ line: 16, type: "Worker" }] },
      visibility: "private",
    },
    {
      symbolId: "inner",
      scope: [],
      startLine: 24,
      endLine: 27,
      calls: [],
      symbolKind: "module",
      visibility: "private",
    },
    {
      symbolId: "inner::Local",
      scope: ["inner"],
      startLine: 25,
      endLine: 25,
      calls: [],
      symbolKind: "class",
      visibility: "public",
    },
    {
      symbolId: "inner.helper",
      scope: ["inner"],
      startLine: 26,
      endLine: 26,
      calls: [{ callText: "super::free()", receiver: "super", member: "free", startLine: 26 }],
      symbolKind: "function",
      visibility: "public",
    },
    {
      symbolId: "free",
      scope: [],
      startLine: 29,
      endLine: 29,
      calls: [],
      symbolKind: "function",
      visibility: "private",
    },
  ],
  fileScope: [],
  classFieldTypes: { Engine: { worker: "Worker" } },
  typeAbstractness: { abstractTypeCount: 1, concreteTypeCount: 2 },
  identifierDeclarations: [
    { name: "worker", kind: "field", line: 5, ownerSymbolId: "Engine", typeName: "Worker", typeSource: "annotation" },
    { name: "n", kind: "field", line: 5, ownerSymbolId: "Engine", typeName: "i32", typeSource: "annotation" },
    {
      name: "new",
      kind: "return",
      line: 14,
      ownerSymbolId: "Engine.new",
      typeName: "Engine",
      typeSource: "annotation",
    },
    { name: "go", kind: "return", line: 15, ownerSymbolId: "Engine#go", typeName: "i32", typeSource: "annotation" },
    { name: "p", kind: "param", line: 15, ownerSymbolId: "Engine#go", typeName: "Worker", typeSource: "annotation" },
    {
      name: "w",
      kind: "local",
      line: 16,
      ownerSymbolId: "Engine#go",
      typeName: "Worker",
      typeSource: "constructor",
      boundCallee: { member: "new", receiver: "Worker" },
    },
  ],
};
