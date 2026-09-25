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
 * The root identifier of a callee chain — `describe`, `it.skip`,
 * `it.skip.each` all root at their first identifier — or null when the
 * expression is not an identifier or a member_expression chain ending in one.
 */
function chainRootName(expression: AstNode, code: string): string | null {
  let cursor: AstNode | null = expression;
  while (cursor?.type === "member_expression") {
    cursor = cursor.childForFieldName("object");
  }
  return cursor?.type === "identifier" ? code.substring(cursor.startIndex, cursor.endIndex) : null;
}

/**
 * The conditional a `(cond ? a : b)(name, fn)` invocation's callee wraps, or
 * null when the callee is not a parenthesized ternary. Express's
 * `(skipRelative ? describe.skip : describe)('current dir', fn)` is the shape
 * (bd tea-rags-mcp-rvuun).
 */
function conditionalCalleeOf(callee: AstNode): AstNode | null {
  let inner: AstNode | null = callee;
  while (inner?.type === "parenthesized_expression") inner = inner.namedChildren[0] ?? null;
  return inner !== callee && inner?.type === "ternary_expression" ? inner : null;
}

/**
 * The one root name BOTH arms of a conditional callee share, or null when the
 * arms root at different names or either arm is not a callee chain.
 * `(skip ? describe.skip : describe)` runs a `describe` whichever arm is
 * taken, so it is that DSL call; `(skip ? describe : it)` is a container or an
 * example depending on a runtime value, so it is neither.
 */
function conditionalCallName(conditional: AstNode, code: string): string | null {
  const consequence = conditional.childForFieldName("consequence");
  const alternative = conditional.childForFieldName("alternative");
  if (!consequence || !alternative) return null;
  const name = chainRootName(consequence, code);
  return name !== null && name === chainRootName(alternative, code) ? name : null;
}

/**
 * Extract the root callee identifier of a call_expression.
 * Returns the identifier's text, or null when the callee is not a plain
 * identifier, a member_expression chain ending in one, a parametrizer call
 * over either, or a parenthesized conditional whose arms share one.
 *
 * Examples:
 *   describe(...)                        → "describe"
 *   it.skip(...)                         → "it"        (member_expression)
 *   it.skip.each(...)                    → "it"        (chained member_expression)
 *   test.each([...])(...)                → "test"      (parametrizer call, bd tea-rags-mcp-b55x2)
 *   (c ? describe.skip : describe)(...)  → "describe"  (conditional callee, bd tea-rags-mcp-rvuun)
 *   (c ? describe : it)(...)             → null        (arms name different calls)
 *   makeSuite()(...)                     → null        (callee is a non-DSL call)
 */
export function getCallName(node: AstNode, code: string): string | null {
  if (node.type !== "call_expression") return null;
  const callee = node.childForFieldName("function");
  if (!callee) return null;

  const chainRoot = chainRootName(callee, code);
  if (chainRoot !== null) return chainRoot;

  const conditional = conditionalCalleeOf(callee);
  if (conditional) return conditionalCallName(conditional, code);

  const parametrizer = parametrizerCallOf(callee, code);
  if (parametrizer) return getCallName(parametrizer, code);

  return null;
}

/**
 * The call as a test author reads it: the callee chain with its modifiers,
 * whitespace removed, a parametrizer's arguments dropped — `it.skip`,
 * `describe.only`, `test.concurrent`, `it.each`. Scopes and examples are
 * addressed by it, so `.skip` / `.only` / `.each` stay visible in their
 * symbolIds (bd tea-rags-mcp-b55x2). Null exactly where {@link getCallName} is.
 *
 * A conditional callee is shown as written in one canonical layout —
 * `(skipRelative ? describe.skip : describe)`: the condition with whitespace
 * runs folded to one space, each arm a chain with whitespace removed. It is
 * named by the whole conditional, not the shared word, for the reason `.skip`
 * is kept: which variant runs is what the author wrote, and a bare `describe`
 * would collide with a sibling `describe` of the same title (bd
 * tea-rags-mcp-rvuun).
 */
export function getCallDisplayName(node: AstNode, code: string): string | null {
  if (getCallName(node, code) === null) return null;
  const callee = node.childForFieldName("function") as AstNode;
  const chain = (expression: AstNode): string =>
    code.substring(expression.startIndex, expression.endIndex).replace(/\s+/g, "");

  const conditional = conditionalCalleeOf(callee);
  if (conditional) {
    const condition = conditional.childForFieldName("condition") as AstNode;
    const conditionText = code.substring(condition.startIndex, condition.endIndex).replace(/\s+/g, " ");
    const consequence = conditional.childForFieldName("consequence") as AstNode;
    const alternative = conditional.childForFieldName("alternative") as AstNode;
    return `(${conditionText} ? ${chain(consequence)} : ${chain(alternative)})`;
  }

  return chain(parametrizerCallOf(callee, code)?.childForFieldName("function") ?? callee);
}

/** Every node kind that opens a function body a DSL call can sit in. */
const FUNCTION_TYPES = new Set([
  "function_declaration",
  "generator_function_declaration",
  "function_expression",
  "function",
  "generator_function",
  "arrow_function",
  "method_definition",
]);

/**
 * True when a function runs where it is written: a callback handed to a call
 * (`describe('x', () => …)`, `cases.forEach((c) => …)`) or an IIFE. Any other
 * function — declared, assigned, returned, a method — is a helper DEFINITION.
 */
function isInvokedInPlace(fn: AstNode): boolean {
  const { parent } = fn;
  if (parent?.type === "arguments") return true;
  if (parent?.type !== "parenthesized_expression") return false;
  const call = parent.parent;
  return call?.type === "call_expression" && call.childForFieldName("function")?.startIndex === parent.startIndex;
}

/**
 * True when a DSL call sits inside a helper definition — `function test(app) {
 * it('x', fn) }`, `const shared = () => { describe(…) }`. Such a call runs only
 * when the helper is called, possibly under many scopes, so it is part of the
 * helper's body and not a chunk of its own (bd tea-rags-mcp-c0vdv, l180).
 * Before, each `it` there became a leaf chunk `<helper>.it` — title lost, ids
 * colliding — and a nested describe claimed its rows while the helper's own
 * statements reached no chunk at all.
 */
export function isInsideHelperDefinition(node: AstNode): boolean {
  for (let cursor = node.parent; cursor; cursor = cursor.parent) {
    if (FUNCTION_TYPES.has(cursor.type) && !isInvokedInPlace(cursor)) return true;
  }
  return false;
}

export const testDslFilterHook: ChunkingHook = {
  name: "test-dsl-filter",

  filterNode(node: AstNode, code: string, filePath: string): boolean | undefined {
    if (node.type !== "call_expression") return undefined;
    if (!isTestFile(filePath)) return false;

    const callName = getCallName(node, code);
    if (!callName) return false;
    return ALL_DSL_METHODS.has(callName) && !isInsideHelperDefinition(node);
  },

  process(_ctx: HookContext): void {
    // No-op — filterNode handles node-level filtering; scope chunking is
    // done by testScopeChunkerHook.
  },
};
