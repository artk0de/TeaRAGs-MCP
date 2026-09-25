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

  // INVARIANT CHANGED (bd tea-rags-mcp-dppnr): the outermost callee of
  // `test.each([...])(...)` is the parametrizer call `test.each([...])`, and
  // getCallName sees through it to `test` (was null — a documented v1
  // limitation). A callee that is any other call stays unreadable.
  it("reads the DSL name through a parametrizer callee (test.each), not through any other call", () => {
    const code = `test.each([1, 2])('handles case %d with a meaningful assertion body', () => {});`;
    const call = findFirstCall(parseJs(code));

    expect(getCallName(call, code)).toBe("test");

    const other = `makeSuite()('handles case %d with a meaningful assertion body', () => {});`;
    expect(getCallName(findFirstCall(parseJs(other)), other)).toBeNull();
  });
});

describe("jsTestDslFilterHook filterNode classification edges", () => {
  // INVARIANT CHANGED (bd tea-rags-mcp-dppnr): a parametrized example is DSL
  // and accepted; a call whose callee is a non-parametrizer call is still
  // rejected because no DSL method name is readable.
  it("accepts a parametrized call (test.each) and rejects one with no readable DSL name (makeSuite()(...))", () => {
    const code = `test.each([1, 2])('handles case %d with a meaningful assertion body', () => {});`;
    const call = findFirstCall(parseJs(code));

    expect(jsTestDslFilterHook.filterNode?.(call as never, code, "tests/user.test.js")).toBe(true);

    const other = `makeSuite()('handles case %d with a meaningful assertion body', () => {});`;
    const otherCall = findFirstCall(parseJs(other));
    expect(jsTestDslFilterHook.filterNode?.(otherCall as never, other, "tests/user.test.js")).toBe(false);
  });

  it("accepts a chained member-expression DSL call (it.skip) in a test file", () => {
    const code = `it.skip('pending case that never runs in this suite', () => {});`;
    const call = findFirstCall(parseJs(code));

    expect(jsTestDslFilterHook.filterNode?.(call as never, code, "tests/user.test.js")).toBe(true);
  });
});
