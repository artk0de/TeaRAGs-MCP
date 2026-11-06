/**
 * A Kotlin call the walker emits.
 *
 * `call_expression` has no fields. The callee is the named child that is not
 * the argument list, type arguments, or trailing lambda. A bare callee is an
 * `identifier`. A member callee is a `navigation_expression`, also field-less:
 * its last `identifier` is the member and the other named child is the
 * receiver. `this.paint()` therefore has receiver `this` (`this_expression`),
 * not a second identifier.
 */

import { isSameAstNode, type AstNode } from "../../../../contracts/types/ast.js";

export interface KotlinCallShape {
  readonly receiver: string | null;
  readonly member: string;
}

export function kotlinCallSiteShape(node: AstNode): KotlinCallShape | null {
  if (node.type !== "call_expression") return null;
  const callee = node.namedChildren.find(
    (child) => child.type !== "value_arguments" && child.type !== "type_arguments" && child.type !== "annotated_lambda",
  );
  if (!callee) return null;
  if (callee.type === "identifier") {
    return callee.text.length > 0 ? { receiver: null, member: callee.text } : null;
  }
  if (callee.type !== "navigation_expression") return null;
  const member = [...callee.namedChildren].reverse().find((child) => child.type === "identifier");
  if (!member || member.text.length === 0) return null;
  const receiver = callee.namedChildren.find((child) => !isSameAstNode(child, member));
  return { receiver: receiver?.text ?? null, member: member.text };
}
