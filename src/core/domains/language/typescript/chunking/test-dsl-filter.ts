/**
 * Test-DSL Filter Hook — accepts call_expression nodes that target the
 * Vitest/Jest/Mocha-style DSL (describe/it/test/beforeEach/afterEach).
 *
 * When call_expression is added to TypeScript's chunkableTypes, every
 * call site becomes a candidate chunk. This hook rejects calls that are
 * not part of a known test DSL and rejects every call in non-test files
 * at O(1) cost via a single filePath regex check.
 *
 * Mirror of hooks/ruby/rspec-filter.ts adapted to TS AST (call_expression
 * with identifier or member_expression callee).
 */

import type { AstNode } from "../../../../contracts/types/ast.js";
import type { ChunkingHook, HookContext } from "../../../../contracts/types/chunker.js";

/** Methods that create describe/context containers. */
const CONTAINER_METHODS = new Set(["describe", "context", "suite"]);

/** Methods that create individual test examples. */
const EXAMPLE_METHODS = new Set(["it", "test", "bench", "fit", "ftest", "xit", "xtest"]);

/** Per-scope setup / teardown methods. */
const SETUP_METHODS = new Set([
  "beforeEach",
  "beforeAll",
  "afterEach",
  "afterAll",
  "before",
  "after",
  "setup",
  "teardown",
]);

/** Union of every recognized DSL method. */
const ALL_DSL_METHODS = new Set<string>([...CONTAINER_METHODS, ...EXAMPLE_METHODS, ...SETUP_METHODS]);

/**
 * Detects test files by canonical layout:
 *   - extensions: *.test.{ts,tsx,js,jsx,mts,cts}, *.spec.{ts,tsx,js,jsx,mts,cts}
 *   - directories: tests/, test/, __tests__/, specs/, spec/, __specs__/
 */
export function isTestFile(filePath: string): boolean {
  if (/\.(test|spec)\.(ts|tsx|js|jsx|mts|cts)$/.test(filePath)) return true;
  return /(^|[/\\])(__tests__|__specs__|tests?|specs?)[/\\]/.test(filePath);
}

/**
 * Extract the root callee identifier of a call_expression.
 * Returns the identifier's text, or null when the callee is not a plain
 * identifier or member_expression chain ending in one.
 *
 * Examples:
 *   describe(...)            → "describe"
 *   it.skip(...)             → "it"           (member_expression)
 *   it.skip.each(...)        → "it"           (chained member_expression)
 *   test.each([...])(...)    → null           (callee is call_expression, not identifier)
 */
export function getCallName(node: AstNode, code: string): string | null {
  if (node.type !== "call_expression") return null;
  const callee = node.childForFieldName("function");
  if (!callee) return null;

  if (callee.type === "identifier") {
    return code.substring(callee.startIndex, callee.endIndex);
  }

  if (callee.type === "member_expression") {
    let cursor: AstNode | null = callee;
    while (cursor?.type === "member_expression") {
      cursor = cursor.childForFieldName("object");
    }
    if (cursor?.type === "identifier") {
      return code.substring(cursor.startIndex, cursor.endIndex);
    }
  }

  return null;
}

export const testDslFilterHook: ChunkingHook = {
  name: "test-dsl-filter",

  filterNode(node: AstNode, code: string, filePath: string): boolean | undefined {
    if (node.type !== "call_expression") return undefined;
    if (!isTestFile(filePath)) return false;

    const callName = getCallName(node, code);
    if (!callName) return false;
    return ALL_DSL_METHODS.has(callName);
  },

  process(_ctx: HookContext): void {
    // No-op — filterNode handles node-level filtering; scope chunking is
    // done by testScopeChunkerHook.
  },
};
