import Parser from "tree-sitter";
import { beforeAll, describe, expect, it } from "vitest";

import {
  getCallName,
  isTestFile,
  testDslFilterHook,
} from "../../../../../../src/core/domains/language/typescript/chunking/test-dsl-filter.js";

let tsLang: unknown;

beforeAll(async () => {
  const tsModule = await import("tree-sitter-typescript");
  tsLang =
    (tsModule.default as { typescript?: unknown })?.typescript ?? (tsModule as { typescript?: unknown }).typescript;
});

function parseTs(code: string): Parser.Tree {
  const parser = new Parser();
  parser.setLanguage(tsLang as Parser.Language);
  return parser.parse(code);
}

/** Walk the full AST and collect every call_expression node. */
function findAllCallExpressions(tree: Parser.Tree): Parser.SyntaxNode[] {
  const out: Parser.SyntaxNode[] = [];
  const walk = (n: Parser.SyntaxNode) => {
    if (n.type === "call_expression") out.push(n);
    for (const c of n.children) walk(c);
  };
  walk(tree.rootNode);
  return out;
}

/** Find the first call_expression whose root callee identifier matches `name`. */
function findCallByName(tree: Parser.Tree, code: string, name: string): Parser.SyntaxNode | undefined {
  for (const call of findAllCallExpressions(tree)) {
    const callee = call.childForFieldName("function");
    if (!callee) continue;

    let rootId: Parser.SyntaxNode | null = null;
    if (callee.type === "identifier") {
      rootId = callee;
    } else if (callee.type === "member_expression") {
      let cursor: Parser.SyntaxNode | null = callee;
      while (cursor?.type === "member_expression") {
        cursor = cursor.childForFieldName("object");
      }
      if (cursor?.type === "identifier") rootId = cursor;
    }
    if (rootId && code.substring(rootId.startIndex, rootId.endIndex) === name) {
      return call;
    }
  }
  return undefined;
}

describe("isTestFile", () => {
  describe("extension matches", () => {
    it("accepts .test.ts", () => {
      expect(isTestFile("src/foo/bar.test.ts")).toBe(true);
    });

    it("accepts .test.tsx", () => {
      expect(isTestFile("src/foo/bar.test.tsx")).toBe(true);
    });

    it("accepts .spec.ts", () => {
      expect(isTestFile("src/foo/bar.spec.ts")).toBe(true);
    });

    it("accepts .spec.tsx", () => {
      expect(isTestFile("src/foo/bar.spec.tsx")).toBe(true);
    });

    it("accepts .test.js / .test.jsx / .test.mts / .test.cts", () => {
      expect(isTestFile("src/foo/bar.test.js")).toBe(true);
      expect(isTestFile("src/foo/bar.test.jsx")).toBe(true);
      expect(isTestFile("src/foo/bar.test.mts")).toBe(true);
      expect(isTestFile("src/foo/bar.test.cts")).toBe(true);
    });
  });

  describe("directory conventions", () => {
    it("accepts files under tests/", () => {
      expect(isTestFile("tests/core/foo.ts")).toBe(true);
    });

    it("accepts files under test/", () => {
      expect(isTestFile("test/foo.ts")).toBe(true);
    });

    it("accepts files under __tests__/", () => {
      expect(isTestFile("src/foo/__tests__/bar.ts")).toBe(true);
    });

    it("accepts files under spec/", () => {
      expect(isTestFile("spec/auth.ts")).toBe(true);
    });

    it("accepts files under specs/", () => {
      expect(isTestFile("specs/auth.ts")).toBe(true);
    });

    it("accepts files under __specs__/", () => {
      expect(isTestFile("src/foo/__specs__/bar.ts")).toBe(true);
    });

    it("accepts Windows-style separators", () => {
      expect(isTestFile("src\\foo\\__tests__\\bar.ts")).toBe(true);
    });
  });

  describe("negatives", () => {
    it("rejects plain source files", () => {
      expect(isTestFile("src/foo/bar.ts")).toBe(false);
    });

    it("rejects .tsx files outside test dirs without test/spec suffix", () => {
      expect(isTestFile("src/components/Button.tsx")).toBe(false);
    });

    it("rejects files merely containing the word 'test' in the basename", () => {
      expect(isTestFile("src/utils/testing.ts")).toBe(false);
      expect(isTestFile("src/utils/test-helpers.ts")).toBe(false);
    });

    it("rejects files outside test layout regardless of extension", () => {
      // isTestFile is a path predicate; non-source extensions inside tests/
      // are filtered out earlier by language routing (LANGUAGE_MAP), so the
      // predicate itself only checks layout. README.md outside any test dir
      // is the negative case here.
      expect(isTestFile("README.md")).toBe(false);
      expect(isTestFile("docs/intro.md")).toBe(false);
    });

    it("rejects dirs that look similar but aren't test dirs", () => {
      expect(isTestFile("src/testing-library/index.ts")).toBe(false);
      expect(isTestFile("docs/specification/api.ts")).toBe(false);
    });
  });
});

describe("testDslFilterHook", () => {
  describe("filterNode", () => {
    it("returns undefined for non-call nodes (class_declaration)", () => {
      const tree = parseTs("class Foo {}");
      const classDecl = tree.rootNode.namedChildren.find((c) => c.type === "class_declaration");
      expect(classDecl).toBeDefined();

      const result = testDslFilterHook.filterNode!(classDecl!, "class Foo {}", "tests/foo.test.ts");
      expect(result).toBeUndefined();
    });

    it("returns undefined for non-call nodes (function_declaration)", () => {
      const tree = parseTs("function foo() {}");
      const fn = tree.rootNode.namedChildren.find((c) => c.type === "function_declaration");
      expect(fn).toBeDefined();

      const result = testDslFilterHook.filterNode!(fn!, "function foo() {}", "tests/foo.test.ts");
      expect(result).toBeUndefined();
    });

    it("rejects call_expression in non-test files", () => {
      const code = "describe('x', () => {})";
      const tree = parseTs(code);
      const call = findCallByName(tree, code, "describe");
      expect(call).toBeDefined();

      const result = testDslFilterHook.filterNode!(call!, code, "src/foo/bar.ts");
      expect(result).toBe(false);
    });

    it("accepts plain identifier describe(...) in test files", () => {
      const code = "describe('User', () => {})";
      const tree = parseTs(code);
      const call = findCallByName(tree, code, "describe");
      expect(call).toBeDefined();

      const result = testDslFilterHook.filterNode!(call!, code, "src/foo/bar.test.ts");
      expect(result).toBe(true);
    });

    it("accepts plain identifier it(...) in test files", () => {
      const code = "it('does a thing', () => {})";
      const tree = parseTs(code);
      const call = findCallByName(tree, code, "it");
      expect(call).toBeDefined();

      const result = testDslFilterHook.filterNode!(call!, code, "tests/foo.ts");
      expect(result).toBe(true);
    });

    it("accepts plain identifier test(...) in test files", () => {
      const code = "test('does a thing', () => {})";
      const tree = parseTs(code);
      const call = findCallByName(tree, code, "test");
      expect(call).toBeDefined();

      const result = testDslFilterHook.filterNode!(call!, code, "tests/foo.ts");
      expect(result).toBe(true);
    });

    it("accepts context(...) container", () => {
      const code = "context('when admin', () => {})";
      const tree = parseTs(code);
      const call = findCallByName(tree, code, "context");
      expect(call).toBeDefined();

      const result = testDslFilterHook.filterNode!(call!, code, "tests/foo.test.ts");
      expect(result).toBe(true);
    });

    it("accepts suite(...) container", () => {
      const code = "suite('group', () => {})";
      const tree = parseTs(code);
      const call = findCallByName(tree, code, "suite");
      expect(call).toBeDefined();

      const result = testDslFilterHook.filterNode!(call!, code, "tests/foo.test.ts");
      expect(result).toBe(true);
    });

    it("accepts member_expression .skip on it (it.skip(...))", () => {
      const code = "it.skip('pending', () => {})";
      const tree = parseTs(code);
      const call = findCallByName(tree, code, "it");
      expect(call).toBeDefined();

      const result = testDslFilterHook.filterNode!(call!, code, "tests/foo.test.ts");
      expect(result).toBe(true);
    });

    it("accepts member_expression .only on describe (describe.only(...))", () => {
      const code = "describe.only('focused', () => {})";
      const tree = parseTs(code);
      const call = findCallByName(tree, code, "describe");
      expect(call).toBeDefined();

      const result = testDslFilterHook.filterNode!(call!, code, "tests/foo.test.ts");
      expect(result).toBe(true);
    });

    it("accepts member_expression .concurrent on test", () => {
      const code = "test.concurrent('parallel', () => {})";
      const tree = parseTs(code);
      const call = findCallByName(tree, code, "test");
      expect(call).toBeDefined();

      const result = testDslFilterHook.filterNode!(call!, code, "tests/foo.test.ts");
      expect(result).toBe(true);
    });

    it("accepts deep member_expression .skip.each on it (it.skip.each(...))", () => {
      // Note: it.skip.each is a chained member expression. The outermost
      // call_expression callee is `it.skip.each` (member_expression). We
      // walk back to the root identifier `it`.
      const code = "it.skip.each([[1, 2]])('cases', () => {})";
      const tree = parseTs(code);
      // The outermost call here is the `(name, fn)` call returned by
      // it.skip.each(table). The DSL root is still `it`.
      const call = findCallByName(tree, code, "it");
      expect(call).toBeDefined();

      const result = testDslFilterHook.filterNode!(call!, code, "tests/foo.test.ts");
      expect(result).toBe(true);
    });

    it("accepts beforeEach setup method", () => {
      const code = "beforeEach(() => {})";
      const tree = parseTs(code);
      const call = findCallByName(tree, code, "beforeEach");
      expect(call).toBeDefined();

      const result = testDslFilterHook.filterNode!(call!, code, "tests/foo.test.ts");
      expect(result).toBe(true);
    });

    it("accepts beforeAll / afterEach / afterAll setup methods", () => {
      for (const name of ["beforeAll", "afterEach", "afterAll"]) {
        const code = `${name}(() => {})`;
        const tree = parseTs(code);
        const call = findCallByName(tree, code, name);
        expect(call, `should find ${name}() call`).toBeDefined();

        const result = testDslFilterHook.filterNode!(call!, code, "tests/foo.test.ts");
        expect(result, `${name} should be accepted`).toBe(true);
      }
    });

    it("rejects non-DSL function calls in test files (console.log)", () => {
      const code = "console.log('debug')";
      const tree = parseTs(code);
      const call = findCallByName(tree, code, "console");
      expect(call).toBeDefined();

      const result = testDslFilterHook.filterNode!(call!, code, "tests/foo.test.ts");
      expect(result).toBe(false);
    });

    it("rejects non-DSL plain identifier calls in test files (helperFn)", () => {
      const code = "helperFn(arg)";
      const tree = parseTs(code);
      const call = findCallByName(tree, code, "helperFn");
      expect(call).toBeDefined();

      const result = testDslFilterHook.filterNode!(call!, code, "tests/foo.test.ts");
      expect(result).toBe(false);
    });

    it("rejects call where callee is a call_expression (test.each([...])(...) outermost)", () => {
      // The outermost call_expression in `test.each([...])('name', fn)` is
      // the (name, fn) invocation whose callee is `test.each([...])` —
      // itself a call_expression, NOT identifier/member_expression. v1
      // does not handle this chained shape.
      const code = "test.each([[1]])('cases', () => {})";
      const tree = parseTs(code);
      // Pick the outermost (top-level statement) call_expression
      const stmt = tree.rootNode.namedChildren.find((c) => c.type === "expression_statement");
      const outermost = stmt?.namedChildren.find((c) => c.type === "call_expression");
      expect(outermost).toBeDefined();
      const calleeType = outermost!.childForFieldName("function")?.type;
      expect(calleeType).toBe("call_expression");

      const result = testDslFilterHook.filterNode!(outermost!, code, "tests/foo.test.ts");
      expect(result).toBe(false);
    });
  });

  describe("process", () => {
    it("is a no-op", () => {
      expect(testDslFilterHook.process).toBeDefined();
      expect(() => {
        testDslFilterHook.process({} as never);
      }).not.toThrow();
    });
  });
});

// ── getCallName direct ───────────────────────────────────────────────

describe("getCallName direct", () => {
  it("returns null for non-call_expression nodes (defensive guard)", () => {
    const tree = parseTs("class Foo {}");
    const classDecl = tree.rootNode.namedChildren.find((c) => c.type === "class_declaration");
    expect(classDecl).toBeDefined();

    expect(getCallName(classDecl!, "class Foo {}")).toBeNull();
  });

  it("returns the root identifier for chained member_expression (.skip.each → it)", () => {
    const code = "it.skip.each([[1, 2]])('cases', () => {})";
    const tree = parseTs(code);
    // Inner call: it.skip.each(table). Its callee is member_expression
    // it.skip.each, which walks back to identifier `it`.
    const calls = findAllCallExpressions(tree);
    const inner = calls.find((c) => {
      const fn = c.childForFieldName("function");
      return fn?.type === "member_expression";
    });
    expect(inner).toBeDefined();

    expect(getCallName(inner!, code)).toBe("it");
  });

  it("returns null when member_expression chain bottoms out at non-identifier", () => {
    // (something.x)() — callee root is a parenthesized_expression, not
    // identifier. The member_expression walk exits via the
    // `cursor?.type === 'identifier'` check failing.
    const code = "(getThing()).method('x')";
    const tree = parseTs(code);
    const stmt = tree.rootNode.namedChildren.find((c) => c.type === "expression_statement");
    const outer = stmt?.namedChildren.find((c) => c.type === "call_expression");
    expect(outer).toBeDefined();
    const calleeType = outer!.childForFieldName("function")?.type;
    expect(calleeType).toBe("member_expression");

    expect(getCallName(outer!, code)).toBeNull();
  });
});
