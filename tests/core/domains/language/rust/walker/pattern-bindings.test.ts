import Parser from "tree-sitter";
import RustLang from "tree-sitter-rust";
import { describe, expect, it } from "vitest";

import { RustLanguage } from "../../../../../../src/core/domains/language/rust/index.js";

function bindingsOf(src: string) {
  const p = new Parser();
  p.setLanguage(RustLang);
  const extraction = new RustLanguage().walker.walk({
    tree: p.parse(src),
    code: src,
    relPath: "svc.rs",
    language: "rust",
    chunks: [{ symbolId: "f", startLine: 1, endLine: src.split("\n").length, scope: [] }],
  });
  return extraction.chunks[0]?.localBindings ?? {};
}

// bd tea-rags-mcp-s3i8m Task 1a — every name a pattern binds shadows the outer
// binding of that name inside the pattern's scope. The walker records the
// projection from the scrutinee; the resolver folds it.
describe("Rust walker — pattern shadow bindings", () => {
  it("binds an if-let payload with a variant projection, scope and scrutinee span", () => {
    const src = ["fn f(x: Foo) {", "    if let Some(ref mut x) = x.get() {", "        x.m();", "    }", "}"].join("\n");
    const shadow = bindingsOf(src).x?.find((binding) => binding.line === 2);
    expect(shadow).toMatchObject({
      line: 2,
      type: "",
      valueKind: "patternProjection",
      sourceExpression: "x.get()",
      projection: [{ kind: "variant", path: "Some", index: 0 }],
      scopeEndLine: 4,
      conditionSpan: { startLine: 2, startColumn: 29, endLine: 2, endColumn: 36 },
    });
  });

  it("binds while-let, match arm, for and destructuring let names", () => {
    const src = [
      "fn f() {",
      "    while let Some(n) = stack.pop() {",
      "    }",
      "    match self.state() {",
      "        State::Ready { peer, count: c, .. } => peer.go(),",
      "        p @ Ok((a, b)) => p.go(),",
      "        _ => {}",
      "    }",
      "    for (k, v) in self.map.iter() {",
      "    }",
      "    let (tx, rx) = make_pair();",
      "}",
    ].join("\n");
    const bindings = bindingsOf(src);
    expect(bindings.n?.[0]).toMatchObject({
      sourceExpression: "stack.pop()",
      projection: [{ kind: "variant", path: "Some", index: 0 }],
      scopeEndLine: 3,
    });
    expect(bindings.peer?.[0]).toMatchObject({
      line: 5,
      sourceExpression: "self.state()",
      projection: [{ kind: "variant", path: "State::Ready", field: "peer" }],
      scopeEndLine: 5,
    });
    expect(bindings.c?.[0]?.projection).toEqual([{ kind: "variant", path: "State::Ready", field: "count" }]);
    expect(bindings.p?.[0]?.projection).toEqual([]);
    expect(bindings.b?.[0]?.projection).toEqual([
      { kind: "variant", path: "Ok", index: 0 },
      { kind: "tuple", index: 1 },
    ]);
    expect(bindings.k?.[0]).toMatchObject({
      sourceExpression: "self.map.iter()",
      projection: [{ kind: "element" }, { kind: "tuple", index: 0 }],
      scopeEndLine: 10,
    });
    expect(bindings.rx?.[0]).toMatchObject({
      line: 11,
      valueKind: "patternProjection",
      sourceExpression: "make_pair()",
      projection: [{ kind: "tuple", index: 1 }],
      scopeEndLine: 12,
    });
  });

  it("binds closure params of a method call as adapter params; a callback param has no projection", () => {
    const src = [
      "fn f() {",
      "    peers.iter().map(|p| p.go());",
      "    opt.map_or(0, |&(a, _)| a.go());",
      "    run(|cb| cb.go());",
      "}",
    ].join("\n");
    const bindings = bindingsOf(src);
    expect(bindings.p?.[0]).toMatchObject({
      sourceExpression: "peers.iter()",
      projection: [{ kind: "adapterParam", adapter: "map", argument: 0, index: 0 }],
      scopeEndLine: 2,
    });
    expect(bindings.a?.[0]?.projection).toEqual([
      { kind: "adapterParam", adapter: "map_or", argument: 1, index: 0 },
      { kind: "tuple", index: 0 },
    ]);
    expect(bindings.cb?.[0]).toMatchObject({ type: "", valueKind: "patternProjection" });
    expect(bindings.cb?.[0]?.projection).toBeUndefined();
  });

  it("binds a typed closure param as a plain typed binding", () => {
    const src = ["fn f() {", "    items.for_each(|x: Foo| x.m());", "}"].join("\n");
    const binding = bindingsOf(src).x?.[0];
    expect(binding).toMatchObject({ line: 2, type: "Foo", scopeEndLine: 2 });
    expect(binding?.valueKind).toBeUndefined();
  });

  it("shadows without a projection for disagreeing or-pattern arms and slices", () => {
    const src = [
      "fn f() {",
      "    match v {",
      "        Self::A(w) | Self::B(w) => w.m(),",
      "        Some(z) | Some(z) => z.m(),",
      "        [head, rest @ ..] => head.m(),",
      "    }",
      "}",
    ].join("\n");
    const bindings = bindingsOf(src);
    expect(bindings.w?.[0]).toMatchObject({ valueKind: "patternProjection", type: "" });
    expect(bindings.w?.[0]?.projection).toBeUndefined();
    expect(bindings.z?.[0]?.projection).toEqual([{ kind: "variant", path: "Some", index: 0 }]);
    expect(bindings.head?.[0]?.projection).toBeUndefined();
    expect(bindings.rest?.[0]?.projection).toBeUndefined();
  });

  it("never binds a path-like identifier pattern (`None`, a constant)", () => {
    const src = [
      "fn f() {",
      "    match v {",
      "        None => {}",
      "        MAX => {}",
      "        _ => {}",
      "    }",
      "}",
    ].join("\n");
    const bindings = bindingsOf(src);
    expect(bindings.None).toBeUndefined();
    expect(bindings.MAX).toBeUndefined();
  });
});
