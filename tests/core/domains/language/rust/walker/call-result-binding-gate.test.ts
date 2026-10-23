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

  // bd tea-rags-mcp-s3i8m — these four once declined the name outright: with no
  // positional pattern scope, an outer `let` would have leaked into the
  // pattern's body. Pattern bindings now carry their own span, so the outer
  // binding answers everywhere but the rows the pattern rebinds the name in.
  it.each([
    ["closure parameter", "let f = |w| {\n        w.inner();\n    };"],
    ["match arm", "match w.get() {\n        w => {\n            w.inner();\n        }\n    }"],
    ["if-let", "if let Some(w) = w.take() {\n        w.inner();\n    }"],
    ["for pattern", "for w in w.iter() {\n        w.inner();\n    }"],
  ])("keeps the outer binding around a %s that rebinds the name, never inside it", (_name, statement) => {
    const bindings = collect(`
fn run(y: Option<u8>) {
    let mut w = make();
    ${statement}
    w.tick();
}
`);
    const innerLine = statement.split("\n").findIndex((line) => line.includes("w.inner()")) + 4;
    expect(bindingAt(bindings, "w", 4)?.callee).toBe("make");
    expect(bindingAt(bindings, "w", innerLine)).toBeUndefined();
    expect(bindingAt(bindings, "w", 4 + statement.split("\n").length)?.callee).toBe("make");
  });

  // bd tea-rags-mcp-s3i8m — a destructuring `let` once declined too; it now
  // shadows the name from its end to the end of its block, as the walker's
  // pattern binding does. Its own scrutinee and `else` block read the outer `let`.
  it("keeps the outer binding up to a destructuring let that rebinds the name, never after it", () => {
    const bindings = collect(`
fn run(y: Option<u8>) {
    let mut w = make();
    let Some(w) = w.get() else {
        return;
    };
    w.inner();
    w.inner();
}
`);
    expect(bindingAt(bindings, "w", 4)?.callee).toBe("make");
    expect(bindingAt(bindings, "w", 5)?.callee).toBe("make");
    expect(bindingAt(bindings, "w", 7)).toBeUndefined();
    expect(bindingAt(bindings, "w", 8)).toBeUndefined();
  });

  // tikv analyze_context.rs: the `if let` scrutinee reads the outer `cms`.
  it("records a multi-line constructor let an if-let in a loop rebinds", () => {
    const bindings = collect(`
fn handle(data: u8) {
    let mut cms = CmSketch::new(
        1,
    );
    for _ in 0..1 {
        if let Some(cms) = cms.as_mut() {
            cms.insert(data);
        }
    }
    finish(cms);
}
`);
    expect(bindingAt(bindings, "cms", 7)?.callee).toBe("CmSketch::new");
    expect(bindingAt(bindings, "cms", 8)).toBeUndefined();
    expect(bindingAt(bindings, "cms", 11)?.callee).toBe("CmSketch::new");
  });

  // servo http_loader.rs: a let rebinding a parameter, read by `take()` and
  // `as_ref()` scrutinees, with a let-else that rebinds it for its block's rest.
  it("records a let that rebinds a parameter, around if-let and let-else rebindings", () => {
    const bindings = collect(`
fn run(sink: BodySink, done: bool) {
    let mut sink = Some(sink);
    if done {
        let Some(sink) = sink.as_ref() else {
            return;
        };
        sink.transmit();
    }
    if let Some(sink) = sink.take() {
        sink.close();
    }
}
`);
    expect(bindingAt(bindings, "sink", 5)?.callee).toBe("Some");
    expect(bindingAt(bindings, "sink", 8)).toBeUndefined();
    expect(bindingAt(bindings, "sink", 10)?.callee).toBe("Some");
    expect(bindingAt(bindings, "sink", 11)).toBeUndefined();
  });

  // A reassignment once declined too; Rust fixes a local's type at its `let`,
  // so an assigned value has that same type and the binding stays.
  it.each([
    ["reassignment", "w = other();"],
    ["compound assignment", "w += 1;"],
  ])("keeps a name a %s writes", (_name, statement) => {
    const bindings = collect(`
fn run(y: Option<u8>) {
    let mut w = make();
    ${statement}
    w.tick();
}
`);
    expect(bindings["w"]).toEqual([expect.objectContaining({ callee: "make" })]);
  });

  it.each([["statement-position project macro", "tokio::pin!(w);"]])(
    "declines a name also bound or touched by a %s",
    (_name, statement) => {
      const bindings = collect(`
fn run(y: Option<u8>) {
    let mut w = make();
    ${statement}
    w.tick();
}
`);
      expect(bindings["w"]).toBeUndefined();
    },
  );

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
