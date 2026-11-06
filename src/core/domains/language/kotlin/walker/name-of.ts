import type { AstNode } from "../../../../contracts/types/ast.js";
import type { NamedSymbol } from "../../../../contracts/types/codegraph.js";
import { methodKindFromClassify } from "../../kernel/index.js";

export function kotlinNameOf(node: AstNode): NamedSymbol | null {
  if (node.type === "class_declaration" || node.type === "object_declaration" || node.type === "companion_object") {
    const id = node.childForFieldName("name");
    if (id && id.text.length > 0) return { name: id.text, descendsInto: true, opensSelfScope: true };
  }
  if (node.type === "function_declaration") {
    const id = node.childForFieldName("name");
    if (!id) return null;
    const methodKind = methodKindFromClassify(node);
    return methodKind ? { name: id.text, descendsInto: false, methodKind } : { name: id.text, descendsInto: false };
  }
  return null;
}
