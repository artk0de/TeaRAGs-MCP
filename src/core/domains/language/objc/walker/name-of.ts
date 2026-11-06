import type { AstNode } from "../../../../contracts/types/ast.js";
import type { NamedSymbol } from "../../../../contracts/types/codegraph.js";
import { methodKindFromClassify } from "../../kernel/index.js";

function firstIdentifier(node: AstNode): AstNode | undefined {
  return node.namedChildren.find((child) => child.type === "identifier");
}

/** Follow the C declarator itself, excluding parameter names. */
function cFunctionName(root: AstNode): string | undefined {
  for (
    let declarator = root.childForFieldName("declarator");
    declarator;
    declarator = declarator.childForFieldName("declarator")
  ) {
    if (declarator.type === "identifier") return declarator.text;
  }
  return undefined;
}

/**
 * First identifier of a method is its first selector keyword (`drawIn:with:`
 * is `drawIn`). That is the grammar's `message_expression.method` field, so
 * calls and definitions share one short name.
 */
export function objcNameOf(node: AstNode): NamedSymbol | null {
  if (node.type === "class_implementation" || node.type === "class_interface" || node.type === "protocol_declaration") {
    const id = firstIdentifier(node);
    if (id) return { name: id.text, descendsInto: true };
  }
  if (node.type === "method_definition" || node.type === "method_declaration") {
    const id = firstIdentifier(node);
    if (id) return { name: id.text, descendsInto: false, methodKind: methodKindFromClassify(node) };
  }
  if (node.type === "function_definition") {
    const name = cFunctionName(node);
    if (name) return { name, descendsInto: false };
  }
  return null;
}
