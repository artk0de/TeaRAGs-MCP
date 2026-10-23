import Parser from "tree-sitter";
import RustLang from "tree-sitter-rust";
import { describe, expect, it } from "vitest";

import { materializeTree } from "../../../../../../src/core/adapters/tree-sitter/materialize.js";
import { collectRustCallResultBindings } from "../../../../../../src/core/domains/language/rust/walker/call-result-bindings.js";

function collect(code: string): Record<string, unknown> {
  const parser = new Parser();
  parser.setLanguage(RustLang);
  const native = parser.parse(code);
  const tree = { rootNode: materializeTree(native.rootNode, code) };
  const byRange = collectRustCallResultBindings(tree.rootNode);
  const merged: Record<string, unknown> = {};
  for (const range of byRange.keys()) Object.assign(merged, byRange.get(range));
  return merged;
}

describe("Rust walker — call-result bindings from method callees", () => {
  it("records a dotted method callee as the binding's init", () => {
    const bindings = collect(`
fn run(e: &Engine) {
    let wb = e.write_batch();
    wb.write();
    let plain = helper();
    plain.tick();
}
`);
    expect(bindings["wb"]).toEqual([expect.objectContaining({ callee: "e.write_batch", endLine: expect.any(Number) })]);
    expect(bindings["plain"]).toEqual([expect.objectContaining({ callee: "helper", endLine: expect.any(Number) })]);
  });

  // Reassigned bindings were once skipped; Rust fixes a local's type at its
  // `let`, so an assignment or update keeps the method call's binding.
  it("keeps reassigned and updated bindings", () => {
    const bindings = collect(`
fn run(e: &Engine) {
    let mut wb = e.write_batch();
    wb = e.other_batch();
    let x = e.first();
    x += 1;
}
`);
    expect(bindings["wb"]).toEqual([expect.objectContaining({ callee: "e.write_batch" })]);
    expect(bindings["x"]).toEqual([expect.objectContaining({ callee: "e.first" })]);
  });
});
