import Parser from "tree-sitter";
import RustLang from "tree-sitter-rust";
import { describe, expect, it } from "vitest";

import { materializeTree } from "../../../../../../src/core/adapters/tree-sitter/materialize.js";
import type { FileExtraction } from "../../../../../../src/core/contracts/types/codegraph.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { RustLanguage } from "../../../../../../src/core/domains/language/rust/index.js";

/**
 * RESIDUAL R5 walker facts (tikv `decimal.rs`): receivers the source types but
 * the walker persisted nothing for — a declared return with a primitive inside
 * (`-> Res<(u8, u8)>`), a method whose return names its own generic
 * (`fn map<U>(..) -> Res<U>`), an `if` / `match` / block initializer, and a
 * `*self` copy inside an `impl`.
 */
function extract(src: string): FileExtraction {
  const language = new RustLanguage();
  const parser = new Parser();
  parser.setLanguage(RustLang);
  const tree = { rootNode: materializeTree(parser.parse(src).rootNode, src) };
  const chunks = collectSymbols(tree, language.walker.nameOf, "::", false, new DefaultSymbolIdComposer());
  return language.walker.walk({ tree, code: src, relPath: "src/a.rs", language: "rust", chunks });
}

function localBindingsOf(src: string, symbolId: string) {
  return extract(src).chunks.find((chunk) => chunk.symbolId === symbolId)?.localBindings ?? {};
}

describe("Rust walker — declared returns with primitives and method generics", () => {
  it("keeps the head of a return whose generic argument cannot be spelled (a tuple of primitives)", () => {
    const { structuredReturnTypes } = extract(
      "pub enum Res<T> { Ok(T) }\nfn fix(a: u8) -> Res<(u8, u8)> { todo!() }\n",
    );
    expect(structuredReturnTypes?.["src/a.rs::fix"]).toEqual({ form: "instance", name: "Res" });
  });

  it("keeps the head of a return whose argument is the method's own generic, and still drops a bare generic", () => {
    const { structuredReturnTypes } = extract(
      [
        "pub enum Res<T> { Ok(T) }",
        "impl<T> Res<T> {",
        "    pub fn map<U, F: FnOnce(T) -> U>(self, f: F) -> Res<U> { todo!() }",
        "}",
        "fn id<T>(t: T) -> T { t }",
      ].join("\n"),
    );
    expect(structuredReturnTypes?.["src/a.rs::Res#map"]).toEqual({ form: "instance", name: "Res" });
    expect(structuredReturnTypes?.["src/a.rs::id"]).toBeUndefined();
  });
});

describe("Rust walker — initializer bindings", () => {
  it("types an if initializer whose constructor arms agree, ignoring diverging and untyped arms", () => {
    const bindings = localBindingsOf(
      [
        "fn run(c: bool, d: bool) {",
        "    let mut res = if c {",
        "        Res::Ok(1)",
        "    } else if d {",
        "        return;",
        "    } else {",
        "        other.map(|v| v)",
        "    };",
        '    let m = match c { true => Res::Truncated(2), _ => { panic!("x") } };',
        "    let b = { prepare(); Res::Ok(3) };",
        "}",
      ].join("\n"),
      "run",
    );
    expect(bindings.res).toEqual([{ line: 2, type: "Res", inferenceShape: "initializerArms" }]);
    expect(bindings.m).toEqual([{ line: 9, type: "Res", inferenceShape: "initializerArms" }]);
    expect(bindings.b).toEqual([{ line: 10, type: "Res", inferenceShape: "initializerArms" }]);
  });

  it("declines an initializer whose constructor arms disagree, or that has no constructor arm", () => {
    const bindings = localBindingsOf(
      [
        "fn run(c: bool) {",
        "    let x = if c { Res::Ok(1) } else { Other::A(2) };",
        "    let y = if c { make() } else { other() };",
        "    let z = if c { Res::Ok(1) };",
        "}",
      ].join("\n"),
      "run",
    );
    expect(bindings.x).toBeUndefined();
    expect(bindings.y).toBeUndefined();
    expect(bindings.z).toBeUndefined();
  });

  it("types `*self` as the impl's type, never inside a trait default body", () => {
    const src = [
      "impl fmt::Display for Decimal {",
      "    fn fmt(&self) {",
      "        let mut dec = *self;",
      "    }",
      "}",
      "trait Show {",
      "    fn show(&self) {",
      "        let me = *self;",
      "    }",
      "}",
    ].join("\n");
    const { chunks } = extract(src);
    const fmt = chunks.find((chunk) => chunk.symbolId.endsWith("fmt"))?.localBindings ?? {};
    const show = chunks.find((chunk) => chunk.symbolId.endsWith("show"))?.localBindings ?? {};
    expect(fmt.dec).toEqual([{ line: 3, type: "Decimal", inferenceShape: "selfCopy" }]);
    expect(show.me).toBeUndefined();
  });
});

describe("Rust walker — inferred shapes are marked for the additive read", () => {
  it("marks an enum variant constructor, and leaves the direct associated-fn constructor unmarked", () => {
    const bindings = localBindingsOf(
      ["fn run(x: u64) {", "    let d = TiInstant::Monotonic(x);", "    let w = Worker::new();", "}"].join("\n"),
      "run",
    );
    expect(bindings.d).toEqual([{ line: 2, type: "TiInstant", inferenceShape: "variantConstructor" }]);
    expect(bindings.w).toEqual([{ line: 3, type: "Worker" }]);
  });

  it("marks every call-result `let` of a reassigned name or an arms initializer, and no plain one", () => {
    const { chunks } = extract(
      [
        "fn run(rect: &Rect, c: bool) {",
        "    let mut rect = rect.to_webrender();",
        "    if c {",
        "        rect = rect.inflate(0.0, 1.0);",
        "    }",
        "    let res = if c { Res::Ok(1) } else { Res::Truncated(2) };",
        "    let plain = make();",
        "}",
      ].join("\n"),
    );
    const bindings = chunks.find((chunk) => chunk.symbolId === "run")?.callResultBindings ?? {};
    expect(bindings.rect?.map((binding) => binding.inferenceShape)).toEqual(["reassignedLet"]);
    expect(bindings.res?.map((binding) => binding.inferenceShape)).toEqual(["initializerArms"]);
    expect(bindings.plain?.map((binding) => binding.inferenceShape)).toEqual([undefined]);
  });
});
