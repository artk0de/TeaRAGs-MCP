/**
 * Kotlin symbol kinds for the nodes `kotlinNameOf` names.
 *
 * `class_declaration` is also an interface (anonymous `interface` keyword)
 * or an enum (`enum` class modifier). A `function_declaration` is a method
 * when `classifyMethod` says so — instance or companion — and a function
 * otherwise (top-level `fun`). A local `fun` inside another function is
 * still reported as a method: `classifyMethod` sees the enclosing type body
 * and does not stop at the outer function.
 */

import type { AstNode } from "../../../../contracts/types/ast.js";
import type { SymbolDefinitionKind } from "../../../../contracts/types/codegraph-symbols.js";
import { methodKindFromClassify } from "../../kernel/index.js";

export function symbolKindOf(node: AstNode): SymbolDefinitionKind | undefined {
  if (node.type === "class_declaration") {
    if (node.children.some((child) => !child.isNamed && child.type === "interface")) return "interface";
    const modifiers = node.children.find((child) => child.type === "modifiers");
    if (modifiers?.children.some((child) => child.type === "class_modifier" && child.text === "enum")) return "enum";
    return "class";
  }
  if (node.type === "object_declaration" || node.type === "companion_object") return "class";
  if (node.type === "function_declaration") {
    return methodKindFromClassify(node) === undefined ? "function" : "method";
  }
  return undefined;
}
