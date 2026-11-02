/**
 * Vitest in-source test recogniser for JavaScript.
 *
 * Vitest runs `if (import.meta.vitest) { … }` blocks of a SOURCE file as tests
 * and the production build defines `import.meta.vitest` as `undefined`, so the
 * block and its whole subtree exist only in the test build. This module answers
 * "is this node such a block" from the grammar's node shapes, never from text
 * matching on the condition. Its consumers — the chunking hooks and the walker
 * — live in this vertical; it mirrors the TypeScript recogniser (verticals never
 * import each other).
 */

import type { AstNode } from "../../../contracts/types/ast.js";

/** `( … )` wrappers, any depth, stripped to the expression inside. */
function unwrapParentheses(node: AstNode): AstNode {
  let inner = node;
  while (inner.type === "parenthesized_expression" && inner.namedChildren.length === 1) {
    inner = inner.namedChildren[0];
  }
  return inner;
}

function textOf(node: AstNode | null, code: string): string | null {
  return node ? code.substring(node.startIndex, node.endIndex) : null;
}

/** `import.meta.vitest`: a member_expression on the `import.meta` meta property, property `vitest`. */
function isImportMetaVitest(node: AstNode, code: string): boolean {
  const expression = unwrapParentheses(node);
  if (expression.type !== "member_expression") return false;
  const object = expression.childForFieldName("object");
  if (object?.type !== "meta_property" || textOf(object, code) !== "import.meta") return false;
  return textOf(expression.childForFieldName("property"), code) === "vitest";
}

/** `typeof import.meta.vitest`. */
function isTypeofImportMetaVitest(node: AstNode, code: string): boolean {
  const expression = unwrapParentheses(node);
  if (expression.type !== "unary_expression") return false;
  if (textOf(expression.childForFieldName("operator"), code) !== "typeof") return false;
  const argument = expression.childForFieldName("argument");
  return argument !== null && isImportMetaVitest(argument, code);
}

/** The string literal `"undefined"` / `'undefined'`. */
function isUndefinedString(node: AstNode, code: string): boolean {
  const expression = unwrapParentheses(node);
  return expression.type === "string" && textOf(expression, code)?.slice(1, -1) === "undefined";
}

/**
 * A condition that holds exactly when Vitest runs the file: `import.meta.vitest`,
 * `import.meta.vitest != null` / `!== undefined` (either inequality), or
 * `typeof import.meta.vitest !== "undefined"`. A negation, a conjunction or any
 * other comparison is not a test-only condition.
 */
function isVitestCondition(condition: AstNode, code: string): boolean {
  const expression = unwrapParentheses(condition);
  if (isImportMetaVitest(expression, code)) return true;
  if (expression.type !== "binary_expression") return false;

  const operator = textOf(expression.childForFieldName("operator"), code);
  if (operator !== "!=" && operator !== "!==") return false;
  const left = expression.childForFieldName("left");
  const right = expression.childForFieldName("right");
  if (!left || !right) return false;

  if (isTypeofImportMetaVitest(left, code)) return isUndefinedString(right, code);
  const rightValue = unwrapParentheses(right);
  return isImportMetaVitest(left, code) && (rightValue.type === "null" || rightValue.type === "undefined");
}

/**
 * True when `node` and its whole subtree exist only in the test build: an
 * `if_statement` whose condition is a Vitest in-source test guard.
 */
export function isInlineTestNode(node: AstNode, code: string): boolean {
  if (node.type !== "if_statement") return false;
  const condition = node.childForFieldName("condition");
  return condition !== null && isVitestCondition(condition, code);
}
