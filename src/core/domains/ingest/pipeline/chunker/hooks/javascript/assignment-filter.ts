/**
 * JavaScript assignment / declaration filter hook.
 *
 * Keeps `expression_statement` and `lexical_declaration` /
 * `variable_declaration` nodes ONLY when they carry a function value —
 * mirrors the codegraph `jsNameOf` shapes documented in
 * `src/core/domains/trajectory/codegraph/symbols/provider.ts` so the
 * chunker's Qdrant payload symbolId set agrees with cg_symbols on the
 * same physical AST node.
 *
 * MUST stay in sync with `provider.ts:jsNameOf` /
 * `isFunctionValuedExpression`. See `.claude/rules/symbolid-convention.md`.
 *
 * bd tea-rags-mcp-kfzx
 */
import type Parser from "tree-sitter";

import type { ChunkingHook } from "../types.js";

/**
 * Walk an `assignment_expression` chain (`a = b = c = fn`) and return the
 * innermost non-assignment value. Mirrors
 * `provider.ts:walkAssignmentChainToTerminalRhs`.
 */
function walkAssignmentChainToTerminalRhs(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  let cur: Parser.SyntaxNode | null = node;
  while (cur?.type === "assignment_expression") {
    const right = cur.childForFieldName("right");
    if (!right) return null;
    cur = right;
  }
  return cur;
}

/**
 * Accept the shapes a callable value can take. Mirrors
 * `provider.ts:isFunctionValuedExpression`.
 */
function isFunctionValuedExpression(node: Parser.SyntaxNode): boolean {
  return node.type === "function_expression" || node.type === "arrow_function" || node.type === "generator_function";
}

function expressionStatementCarriesFunction(node: Parser.SyntaxNode): boolean {
  // expression_statement -> assignment_expression -> ... -> function/arrow.
  // OR expression_statement -> call_expression -> getter-install helper /
  //                                            -> methods.forEach dispatch.
  // Tree-sitter wraps the inner expression as a direct child (named).
  for (const child of node.children) {
    if (child.type === "assignment_expression") {
      const terminal = walkAssignmentChainToTerminalRhs(child);
      return terminal !== null && isFunctionValuedExpression(terminal);
    }
    if (child.type === "call_expression") {
      if (callExpressionIsGetterHelper(child)) return true;
      if (callExpressionIsForEachDispatch(child)) return true;
    }
  }
  return false;
}

/**
 * Recognise the `<x>.forEach(function(<param>) { <obj>[<param>] = fn; })`
 * shape so the wrapping expression_statement survives the chunkable-types
 * filter and reaches the symbol resolver. Receiver-package validation
 * (must resolve to npm `methods`) is enforced LATER, in
 * `extractJsForEachDispatchSymbols`. This filter is intentionally
 * permissive — false-positive expression_statements survive but produce
 * NO chunk if the resolver rejects them. bd tea-rags-mcp-z95o.
 */
function callExpressionIsForEachDispatch(call: Parser.SyntaxNode): boolean {
  const callee = call.childForFieldName("function");
  const args = call.childForFieldName("arguments");
  if (!callee || !args) return false;
  if (callee.type !== "member_expression") return false;
  const prop = callee.childForFieldName("property");
  if (prop?.type !== "property_identifier" || prop.text !== "forEach") return false;
  const fnArg = args.namedChildren[0];
  if (!fnArg || !isFunctionValuedExpression(fnArg)) return false;
  return true;
}

/**
 * Recognise getter-install helpers at the filter stage so their
 * expression_statement survives the chunkable-types filter and reaches
 * the symbol resolver. Mirrors provider.ts:jsGetterHelperEmission
 * (just the shape detection — the symbol resolver does the actual
 * naming). bd tea-rags-mcp-d1f8.
 */
function callExpressionIsGetterHelper(call: Parser.SyntaxNode): boolean {
  const callee = call.childForFieldName("function");
  const args = call.childForFieldName("arguments");
  if (!callee || !args) return false;
  const namedArgs = args.namedChildren;
  if (namedArgs.length < 3) return false;

  if (callee.type === "member_expression") {
    const obj = callee.childForFieldName("object");
    const prop = callee.childForFieldName("property");
    if (
      obj?.type === "identifier" &&
      obj.text === "Object" &&
      prop?.type === "property_identifier" &&
      prop.text === "defineProperty"
    ) {
      const descriptor = namedArgs[2];
      if (descriptor?.type !== "object") return false;
      // Defer the get/set check to the resolver — at filter stage we
      // just need an object descriptor of plausible shape.
      return true;
    }
  }

  if (callee.type === "identifier" && callee.text === "defineGetter") {
    const fnArg = namedArgs[2];
    return fnArg !== undefined && isFunctionValuedExpression(fnArg);
  }
  return false;
}

function declarationCarriesFunction(node: Parser.SyntaxNode): boolean {
  // lexical_declaration / variable_declaration has 1+ variable_declarator
  // children. Keep the node if ANY declarator's `value` is function-valued.
  for (const child of node.children) {
    if (child.type !== "variable_declarator") continue;
    const value = child.childForFieldName("value");
    if (value && isFunctionValuedExpression(value)) return true;
  }
  return false;
}

export const jsAssignmentFilterHook: ChunkingHook = {
  name: "js-assignment-filter",
  process: () => {
    // Filter-only hook — no per-container processing.
  },
  filterNode: (node) => {
    if (node.type === "expression_statement") {
      return expressionStatementCarriesFunction(node) ? true : false;
    }
    if (node.type === "lexical_declaration" || node.type === "variable_declaration") {
      return declarationCarriesFunction(node) ? true : false;
    }
    return undefined; // no opinion on other node types
  },
};
