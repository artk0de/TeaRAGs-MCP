import Parser from "tree-sitter";
import RustLang from "tree-sitter-rust";
import { describe, expect, it } from "vitest";

import { materializeTree } from "../../../../../../src/core/adapters/tree-sitter/materialize.js";
import type { CallContext, CallResultBinding } from "../../../../../../src/core/contracts/types/codegraph.js";
import { rustCallResultBindingOf } from "../../../../../../src/core/domains/language/rust/resolver/declared-call-result-type.js";
import { collectRustCallResultBindings } from "../../../../../../src/core/domains/language/rust/walker/call-result-bindings.js";

function collect(code: string): Record<string, CallResultBinding[]> {
  const parser = new Parser();
  parser.setLanguage(RustLang);
  const native = parser.parse(code);
  const tree = { rootNode: materializeTree(native.rootNode, code) };
  const byRange = collectRustCallResultBindings(tree.rootNode);
  const merged: Record<string, CallResultBinding[]> = {};
  for (const range of byRange.keys()) Object.assign(merged, byRange.get(range));
  return merged;
}

function bindingAt(bindings: Record<string, CallResultBinding[]>, name: string, atLine: number) {
  return rustCallResultBindingOf(name, atLine, { callResultBindings: bindings } as unknown as CallContext);
}

describe("Rust walker — call-result bindings gate per name (2g2og.24 S1)", () => {
  it("records a let whose name no other construct touches, despite macros, matches, closures and field writes", () => {
    const bindings = collect(`
fn run(&mut self, y: u8) {
    println!("{}", y);
    let w = make();
    match y { 0 => {}, other => drop(other) }
    let f = |a| a + 1;
    self.x = y;
    w.tick();
}
`);
    expect(bindings["w"]).toEqual([{ line: 4, endLine: 4, scopeEndLine: 9, callee: "make", initExpression: "make()" }]);
  });

  it.each([
    ["closure parameter", "let f = |w| w;"],
    ["match arm", "match y { w => drop(w) }"],
    ["if-let", "if let Some(w) = y { drop(w) }"],
    ["for pattern", "for w in y {}"],
    ["destructuring let", "let (w, _) = pair();"],
    ["statement-position project macro", "tokio::pin!(w);"],
    ["reassignment", "w = other();"],
    ["compound assignment", "w += 1;"],
  ])("declines a name also bound or touched by a %s", (_name, statement) => {
    const bindings = collect(`
fn run(y: Option<u8>) {
    let mut w = make();
    ${statement}
    w.tick();
}
`);
    expect(bindings["w"]).toBeUndefined();
  });

  it("keeps a name mentioned only by an allowlisted std macro", () => {
    const bindings = collect(`
fn run() {
    let w = make();
    assert_eq!(w.len(), 1);
    w.tick();
}
`);
    expect(bindings["w"]).toEqual([expect.objectContaining({ callee: "make" })]);
  });

  it("declines a callee head that a nested fn or an in-body use names", () => {
    const bindings = collect(`
fn run() {
    fn make() -> u8 { 0 }
    let w = make();
    use crate::other::build;
    let v = build();
    w.tick();
    v.tick();
}
`);
    expect(bindings["w"]).toBeUndefined();
    expect(bindings["v"]).toBeUndefined();
  });

  it("scopes a block-local let to its enclosing block", () => {
    const bindings = collect(`
fn run() {
    if ready() {
        let w = make();
        w.tick();
    }
    w.tick();
}
`);
    expect(bindings["w"]).toEqual([{ line: 4, endLine: 4, scopeEndLine: 6, callee: "make", initExpression: "make()" }]);
    expect(bindingAt(bindings, "w", 5)?.callee).toBe("make");
    expect(bindingAt(bindings, "w", 7)).toBeUndefined();
  });

  it("selects the shadowing let positionally", () => {
    const bindings = collect(`
fn run() {
    let x = a();
    x.first();
    let x = x.b();
    x.second();
}
`);
    expect(bindings["x"]).toHaveLength(2);
    expect(bindingAt(bindings, "x", 4)?.callee).toBe("a");
    expect(bindingAt(bindings, "x", 5)?.callee).toBe("a");
    expect(bindingAt(bindings, "x", 6)?.callee).toBe("x.b");
  });

  it("returns to the outer binding after an inner block's shadow ends", () => {
    const bindings = collect(`
fn run() {
    let x = a();
    {
        let x = b();
        x.inner();
    }
    x.outer();
}
`);
    expect(bindingAt(bindings, "x", 6)?.callee).toBe("b");
    expect(bindingAt(bindings, "x", 8)?.callee).toBe("a");
  });

  it("declines a name a non-call let shadows", () => {
    const bindings = collect(`
fn run() {
    let x = a();
    let x = 5;
    x.tick();
}
`);
    expect(bindings["x"]).toBeUndefined();
  });

  it.each([
    ["try", "make()?", "make()?", "make()?"],
    ["unwrap tail", "make().unwrap()", "make().unwrap", "make().unwrap()"],
    ["borrow", "&make()", "make", "make()"],
    ["mutable borrow in parens", "(&mut make())", "make", "make()"],
    ["path callee", "Builder::new()", "Builder::new", "Builder::new()"],
    ["multi-line call", "make(\n        1,\n    )", "make", "make( 1, )"],
  ])("records the %s init shape", (_name, init, callee, initExpression) => {
    const bindings = collect(`
fn run() {
    let w = ${init};
    w.tick();
}
`);
    expect(bindings["w"]).toEqual([expect.objectContaining({ callee, initExpression })]);
  });

  it("still declines the whole function on a parse error", () => {
    const bindings = collect(`
fn run() {
    let w = make();
    let = ;
    w.tick();
}
`);
    expect(bindings["w"]).toBeUndefined();
  });
});
