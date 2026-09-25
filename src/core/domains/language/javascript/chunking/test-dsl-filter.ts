/**
 * Test-DSL Filter Hook for JavaScript — accepts call_expression nodes that
 * target the Vitest/Jest/Mocha-style DSL (describe/it/test/beforeEach/afterEach).
 *
 * When call_expression is added to JavaScript's chunkableTypes, every call
 * site becomes a candidate chunk. This hook rejects calls that are not part
 * of a known test DSL and rejects every call in non-test files at O(1) cost
 * via a single filePath regex check.
 *
 * Mirror of ../typescript/chunking/test-dsl-filter.ts against the
 * tree-sitter-javascript grammar — same node vocabulary (call_expression
 * with `function` / `arguments` fields, member_expression callee chains),
 * verified field-for-field against node-types.json (bd tea-rags-mcp-1etj8).
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
 *   - extensions: *.test.{js,jsx,mts,cts}, *.spec.{js,jsx,mts,cts}
 *   - directories: tests/, test/, __tests__/, specs/, spec/, __specs__/
 */
export function isTestFile(filePath: string): boolean {
  if (/\.(test|spec)\.(js|jsx|mts|cts)$/.test(filePath)) return true;
  return /(^|[/\\])(__tests__|__specs__|tests?|specs?)[/\\]/.test(filePath);
}

/**
 * Member names that turn a DSL call into a PARAMETRIZER: `it.each(table)`,
 * `describe.each(table)`, `test.for(cases)`, `it.skipIf(cond)`,
 * `describe.runIf(cond)` return the function that is then called with
 * `(name, fn)`. The outer call's callee is therefore itself a call_expression,
 * and both readers below see through it to the DSL call it parametrizes.
 */
const PARAMETRIZER_MEMBERS = new Set(["each", "for", "skipIf", "runIf"]);

/**
 * The parametrizer call a `(name, fn)` invocation's callee is, or null when the
 * callee is any other call — `makeSuite()('x', fn)` is not DSL.
 */
function parametrizerCallOf(callee: AstNode, code: string): AstNode | null {
  if (callee.type !== "call_expression") return null;
  const fn = callee.childForFieldName("function");
  if (fn?.type !== "member_expression") return null;
  const property = fn.childForFieldName("property");
  if (!property) return null;
  return PARAMETRIZER_MEMBERS.has(code.substring(property.startIndex, property.endIndex)) ? callee : null;
}

/**
 * Extract the root callee identifier of a call_expression.
 * Returns the identifier's text, or null when the callee is not a plain
 * identifier, a member_expression chain ending in one, or a parametrizer call
 * over either.
 *
 * Examples:
 *   describe(...)            → "describe"
 *   it.skip(...)             → "it"           (member_expression)
 *   it.skip.each(...)        → "it"           (chained member_expression)
 *   test.each([...])(...)    → "test"         (parametrizer call, bd tea-rags-mcp-dppnr)
 *   makeSuite()(...)         → null           (callee is a non-DSL call)
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

  const parametrizer = parametrizerCallOf(callee, code);
  if (parametrizer) return getCallName(parametrizer, code);

  return null;
}

/**
 * The call as a test author reads it: the callee chain with its modifiers,
 * whitespace removed, a parametrizer's arguments dropped — `it.skip`,
 * `context.only`, `test.concurrent`, `it.each`. Scopes and examples are
 * addressed by it, so `.skip` / `.only` / `.each` stay visible in their
 * symbolIds (bd tea-rags-mcp-dppnr). Null exactly where {@link getCallName} is.
 */
export function getCallDisplayName(node: AstNode, code: string): string | null {
  if (getCallName(node, code) === null) return null;
  const callee = node.childForFieldName("function") as AstNode;
  const shown = parametrizerCallOf(callee, code)?.childForFieldName("function") ?? callee;
  return code.substring(shown.startIndex, shown.endIndex).replace(/\s+/g, "");
}

export const jsTestDslFilterHook: ChunkingHook = {
  name: "js-test-dsl-filter",

  filterNode(node: AstNode, code: string, filePath: string): boolean | undefined {
    if (node.type !== "call_expression") return undefined;
    if (!isTestFile(filePath)) return false;

    const callName = getCallName(node, code);
    if (!callName) return false;
    return ALL_DSL_METHODS.has(callName);
  },

  process(_ctx: HookContext): void {
    // No-op — filterNode handles node-level filtering; scope chunking is
    // done by jsTestScopeChunkerHook.
  },
};
