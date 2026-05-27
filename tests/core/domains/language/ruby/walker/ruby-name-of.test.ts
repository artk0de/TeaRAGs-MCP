/**
 * Direct unit tests for `rbNameOf` — the codegraph-side Ruby `nameOf`
 * (src/core/domains/language/ruby/walker/name-of.ts). The provider tests in
 * `domains/trajectory/codegraph/symbols/provider.test.ts` exercise the
 * end-to-end symbol-table emission, but they route through
 * `provider.buildFileSignals`. These tests call `rbNameOf` directly on a parsed
 * macro `call` node — the same shape `collectSymbols` passes in at runtime —
 * to pin the DSL-macro emission contract.
 *
 * Convention mirrors the sibling chunker test `ruby-macros.test.ts`: Parser +
 * RbLang, a `parse()` helper, a container finder. `rbNameOf` returns
 * `NamedSymbol[]` with shape `{ name, descendsInto, methodKind }` (NOT the
 * chunker's `{ name, kind, startLine, endLine }`).
 */

import Parser from "tree-sitter";
import RbLang from "tree-sitter-ruby";
import { describe, expect, it } from "vitest";

import { rbNameOf } from "../../../../../../src/core/domains/language/ruby/walker/name-of.js";

function parse(src: string): Parser.Tree {
  const parser = new Parser();
  parser.setLanguage(RbLang as unknown as Parser.Language);
  return parser.parse(src);
}

/**
 * Find the first `call` / `method_call` node whose method identifier text
 * matches `macroName`, searching the body of the first `class`/`module`
 * container in the tree. This is the macro-call node `collectSymbols` would
 * hand to `rbNameOf`.
 */
function findMacroCall(tree: Parser.Tree, macroName: string): Parser.SyntaxNode {
  const stack: Parser.SyntaxNode[] = [tree.rootNode];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === "call" || node.type === "method_call") {
      const methodField = node.childForFieldName("method");
      const methodNode = methodField ?? node.children.find((c) => c.type === "identifier");
      if (methodNode?.text === macroName) return node;
    }
    for (const child of node.namedChildren) stack.push(child);
  }
  throw new Error(`No ${macroName} call node found`);
}

describe("rbNameOf — class/module-level accessor macros (catalogue-derived)", () => {
  it("rbNameOf emits cattr_accessor as static class-level accessors (catalogue-derived)", () => {
    const tree = parse("class C\n  cattr_accessor :shared\nend\n");
    const node = findMacroCall(tree, "cattr_accessor");
    expect(rbNameOf(node)).toEqual([
      { name: "shared", descendsInto: false, methodKind: "static" },
      { name: "shared=", descendsInto: false, methodKind: "static" },
    ]);
  });

  it("rbNameOf emits mattr_accessor as static class-level accessors (catalogue-derived)", () => {
    const tree = parse("module M\n  mattr_accessor :defaults\nend\n");
    const node = findMacroCall(tree, "mattr_accessor");
    expect(rbNameOf(node)).toEqual([
      { name: "defaults", descendsInto: false, methodKind: "static" },
      { name: "defaults=", descendsInto: false, methodKind: "static" },
    ]);
  });
});
