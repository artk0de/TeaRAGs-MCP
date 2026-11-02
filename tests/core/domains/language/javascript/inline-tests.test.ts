import Parser from "tree-sitter";
import JsLang from "tree-sitter-javascript";
import { describe, expect, it } from "vitest";

import { materializeTree } from "../../../../../src/core/adapters/tree-sitter/materialize.js";
import type { AstNode } from "../../../../../src/core/contracts/types/ast.js";
import { isInlineTestNode } from "../../../../../src/core/domains/language/javascript/inline-tests.js";

function firstStatement(code: string): AstNode {
  const parser = new Parser();
  parser.setLanguage(JsLang);
  return materializeTree(parser.parse(code).rootNode, code).namedChildren[0];
}

describe("isInlineTestNode (JavaScript, Vitest in-source tests)", () => {
  const cases: [string, boolean][] = [
    ["if (import.meta.vitest) {}", true],
    ["if ((import.meta.vitest)) {}", true],
    ["if (import.meta.vitest != null) {}", true],
    ["if (import.meta.vitest !== undefined) {}", true],
    ["if (typeof import.meta.vitest !== 'undefined') {}", true],
    ['if (typeof import.meta.vitest !== "undefined") {}', true],
    ["if (!import.meta.vitest) {}", false],
    ["if (import.meta.env.DEV) {}", false],
    ["if (vitest) {}", false],
    ["if (import.meta.vitest && flag) {}", false],
    ["if (import.meta.vitest == null) {}", false],
    ["if (typeof import.meta.vitest === 'undefined') {}", false],
    // An else branch is production code, so the if as a whole is not test-only.
    ["if (import.meta.vitest) {} else { run(); }", false],
    ["if (import.meta.vitest != null) {} else if (flag) {}", false],
  ];

  it.each(cases)("%s → %s", (code, expected) => {
    expect(isInlineTestNode(firstStatement(code), code)).toBe(expected);
  });

  it("is false for a node that is not an if statement", () => {
    const code = "import.meta.vitest;";
    expect(isInlineTestNode(firstStatement(code), code)).toBe(false);
  });
});
