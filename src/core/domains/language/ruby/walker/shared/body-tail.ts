import type { AstNode } from "../../../../../contracts/types/ast.js";

/**
 * A def body's last value-producing expression: `rescue` / `ensure` / `else`
 * tails skipped so the tail seen is the NORMAL-path value, and an explicit
 * `return EXPR` unwrapped to `EXPR`. `null` when the body produces no value.
 */
export function rubyBodyTailExpression(method: AstNode): AstNode | null {
  const body = method.childForFieldName("body");
  if (!body) return null;
  const stmts = body.namedChildren.filter((n) => n.type !== "rescue" && n.type !== "ensure" && n.type !== "else");
  let last = stmts[stmts.length - 1];
  if (!last) return null;
  if (last.type === "return") {
    const arg = last.namedChildren[0];
    if (!arg) return null;
    last = arg.type === "argument_list" ? arg.namedChildren[0] : arg;
    if (!last) return null;
  }
  return last;
}
