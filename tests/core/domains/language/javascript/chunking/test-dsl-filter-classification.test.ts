import Parser from "tree-sitter";
import JsLang from "tree-sitter-javascript";
import { beforeAll, describe, expect, it } from "vitest";

import {
  getCallName,
  jsTestDslFilterHook,
} from "../../../../../../src/core/domains/language/javascript/chunking/test-dsl-filter.js";

let jsParser: Parser;

beforeAll(() => {
  jsParser = new Parser();
  jsParser.setLanguage(JsLang);
});

function parseJs(code: string): Parser.Tree {
  return jsParser.parse(code);
}

/** First call_expression at any depth under the root program. */
function findFirstCall(tree: Parser.Tree): Parser.SyntaxNode {
  const visit = (node: Parser.SyntaxNode): Parser.SyntaxNode | null => {
    if (node.type === "call_expression") return node;
    for (const child of node.namedChildren) {
      const hit = visit(child);
      if (hit) return hit;
    }
    return null;
  };
  const hit = visit(tree.rootNode);
  if (!hit) throw new Error("No call_expression found");
  return hit;
}

describe("getCallName classification edges", () => {
  it("returns null for a node that is not a call expression", () => {
    const code = `class User { render() {} }`;
    const tree = parseJs(code);
    const classDecl = tree.rootNode.namedChildren.find((c) => c.type === "class_declaration");
    expect(classDecl).toBeDefined();

    expect(getCallName(classDecl as never, code)).toBeNull();
  });

  it("returns the root identifier for a plain member-expression callee", () => {
    const code = `it.skip('pending case that never runs in this suite', () => {});`;
    const call = findFirstCall(parseJs(code));

    expect(getCallName(call, code)).toBe("it");
  });

  // Documented v1 limitation (.claude/rules/test-spec-chunking.md): the
  // outermost callee of `test.each([...])(...)` is itself a call_expression,
  // so no DSL method name is readable and the call is rejected.
  it("returns null for chained-call DSL whose callee is itself a call (test.each)", () => {
    const code = `test.each([1, 2])('handles case %d with a meaningful assertion body', () => {});`;
    const call = findFirstCall(parseJs(code));

    expect(getCallName(call, code)).toBeNull();
  });
});

describe("jsTestDslFilterHook filterNode classification edges", () => {
  it("rejects a call in a test file when no DSL method name is readable (test.each)", () => {
    const code = `test.each([1, 2])('handles case %d with a meaningful assertion body', () => {});`;
    const call = findFirstCall(parseJs(code));

    expect(jsTestDslFilterHook.filterNode?.(call as never, code, "tests/user.test.js")).toBe(false);
  });

  it("accepts a chained member-expression DSL call (it.skip) in a test file", () => {
    const code = `it.skip('pending case that never runs in this suite', () => {});`;
    const call = findFirstCall(parseJs(code));

    expect(jsTestDslFilterHook.filterNode?.(call as never, code, "tests/user.test.js")).toBe(true);
  });
});
