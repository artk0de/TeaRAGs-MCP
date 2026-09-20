import Parser from "tree-sitter";
import GoLang from "tree-sitter-go";
import { describe, expect, it } from "vitest";

import { goNameOf } from "../../../../../../src/core/domains/language/go/walker/name-of.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { materializeTree } from "../../../../../../src/core/infra/materialize.js";

function parse(src: string) {
  const p = new Parser();
  p.setLanguage(GoLang);
  return p.parse(src);
}

/**
 * Through the EXACT seam production runs (file-extractor + chunker worker both
 * materialize the tree, then call `collectSymbols(tree, walker.nameOf, ...)`),
 * so the rows asserted here are the rows the codegraph graph and the walker's
 * own call attribution see.
 */
function symbolRowsOf(src: string) {
  const root = materializeTree(parse(src).rootNode, src);
  return collectSymbols({ rootNode: root }, (node) => goNameOf(node), ".", false, new DefaultSymbolIdComposer());
}

// bd tea-rags-mcp-fov8f — a grouped type declaration used to contribute only
// its FIRST spec's symbol: `goNameOf` read the `type_declaration` node through
// the single-form clause of `goSymbolOf` (`.find()`), so every spec after the
// first was invisible to the graph — no row, no resolution. The spec node is
// the emission unit now: each `type_spec` / `type_alias` answers `nameOf` on
// its own line range, the single form included.
describe("Go walker — grouped type declarations (type ( ... ))", () => {
  it("emits every spec of a group — struct, struct, interface — each on its own line range", () => {
    const src = [
      "package pkg",
      "type (",
      "\tA struct { n int }",
      "\tB struct{}",
      "\tI interface { M() }",
      ")",
      "",
    ].join("\n");
    expect(symbolRowsOf(src)).toEqual([
      { symbolId: "A", startLine: 3, endLine: 3, scope: [] },
      { symbolId: "B", startLine: 4, endLine: 4, scope: [] },
      { symbolId: "I", startLine: 5, endLine: 5, scope: [] },
    ]);
  });

  it("emits alias, channel and func-typed specs of a group too", () => {
    const src = ["package pkg", "type (", "\tHandler = func()", "\tCh chan int", "\tFn func(a A) error", ")", ""].join(
      "\n",
    );
    expect(symbolRowsOf(src)).toEqual([
      { symbolId: "Handler", startLine: 3, endLine: 3, scope: [] },
      { symbolId: "Ch", startLine: 4, endLine: 4, scope: [] },
      { symbolId: "Fn", startLine: 5, endLine: 5, scope: [] },
    ]);
  });

  it("lands methods declared on grouped types on their own receiver", () => {
    const src = [
      "package pkg",
      "type (",
      "\tA struct { n int }",
      "\tB struct{}",
      ")",
      "",
      "func (a A) M() int { return a.n }",
      "",
      "func (b *B) N() {}",
      "",
    ].join("\n");
    expect(
      symbolRowsOf(src)
        .map((r) => r.symbolId)
        .sort(),
    ).toEqual(["A", "A#M", "B", "B#N"]);
  });

  it("keeps the single declaration emitting exactly one symbol on its own line", () => {
    const src = ["package pkg", "type X struct { v int }", ""].join("\n");
    expect(symbolRowsOf(src)).toEqual([{ symbolId: "X", startLine: 2, endLine: 2, scope: [] }]);
  });
});
