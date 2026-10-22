import Parser from "tree-sitter";
import RustLang from "tree-sitter-rust";
import { describe, expect, it } from "vitest";

import { materializeTree } from "../../../../../../src/core/adapters/tree-sitter/materialize.js";
import type { CallRef } from "../../../../../../src/core/contracts/types/codegraph-extraction.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { RustLanguage } from "../../../../../../src/core/domains/language/rust/index.js";

function callsOf(src: string, materialized: boolean): CallRef[] {
  const language = new RustLanguage();
  const parser = new Parser();
  parser.setLanguage(RustLang);
  const parsed = parser.parse(src);
  expect(parsed.rootNode.hasError).toBe(false);
  const tree = { rootNode: materialized ? materializeTree(parsed.rootNode, src) : parsed.rootNode };
  const chunks = collectSymbols(
    tree,
    (node) => language.walker.nameOf(node),
    language.kernel.scopeSeparator ?? ".",
    language.kernel.disambiguateOverloads ?? false,
    new DefaultSymbolIdComposer(),
  );
  const extraction = language.walker.walk({ tree, code: src, relPath: "src/calls.rs", language: "rust", chunks });
  return extraction.chunks.find(({ symbolId }) => symbolId === "run")?.calls ?? [];
}

const pos = (call: CallRef | undefined) => [call?.memberStartLine, call?.memberStartColumn];

describe.each([false, true])("Rust call member token — materialized=%s", (materialized) => {
  const calls = (body: string[]) => callsOf(["fn run() {", ...body, "}"].join("\n"), materialized);

  it("records the field of a method call", () => {
    const [call] = calls(["    a.b();"]);
    expect(pos(call)).toEqual([2, 6]);
  });

  it("gives nested calls that share a start two distinct member tokens", () => {
    const found = calls(["    A::new().build();"]);
    const build = found.find(({ member }) => member === "build");
    const created = found.find(({ member }) => member === "new");
    expect(found).toHaveLength(2);
    expect(build?.startLine).toBe(created?.startLine);
    expect(build?.startColumn).toBe(created?.startColumn);
    expect(pos(created)).toEqual([2, 7]);
    expect(pos(build)).toEqual([2, 13]);
  });

  it("records the member token on the line it sits on in a multi-line chain", () => {
    const found = calls(["    worker", "        .first()", "        .second();"]);
    const second = found.find(({ member }) => member === "second");
    expect(second?.startLine).toBe(2);
    expect(pos(second)).toEqual([4, 9]);
  });

  it("records a turbofish, bare, and scoped path callee", () => {
    const found = calls(["    foo::<T>();", "    path::to::f();", "    Foo::bar();"]);
    expect(pos(found.find(({ member }) => member === "foo"))).toEqual([2, 4]);
    expect(pos(found.find(({ member }) => member === "f"))).toEqual([3, 14]);
    expect(pos(found.find(({ member }) => member === "bar"))).toEqual([4, 9]);
  });

  it("records a macro name, plain and scoped", () => {
    const found = calls(["    m!();", "    crate::m2!();"]);
    expect(pos(found.find(({ member }) => member === "m"))).toEqual([2, 4]);
    expect(pos(found.find(({ member }) => member === "m2"))).toEqual([3, 11]);
  });

  it("counts columns in UTF-16 code units after a non-ASCII prefix", () => {
    // The emoji is two UTF-16 units (four UTF-8 bytes), so `b` sits at UTF-16 column 20 (UTF-8 byte 22).
    const [call] = calls(['    let s = "😀"; a.b();']);
    expect(pos(call)).toEqual([2, 20]);
  });
});
