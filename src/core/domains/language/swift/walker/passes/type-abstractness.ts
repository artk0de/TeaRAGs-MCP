/**
 * Swift type-abstractness census (bd tea-rags-mcp-r8hme.8): a protocol is
 * abstract. A type that declares behaviour of its own is concrete; a type whose
 * members are only initializers, stored properties and computed properties
 * declares no behaviour (bd tea-rags-mcp-44cpv, decision c-1=a: an error
 * struct, a value object; an empty body is the degenerate case) and counts as
 * neither. An extension re-opens a type declared elsewhere and counts as
 * neither too. The kind is the walker's own reading (`swiftTypeDeclarationKind`),
 * the one `typeDeclarations` publishes.
 *
 * The member rule: a `func` is behaviour (static or instance), and so is a
 * property whose value is a closure literal; `init` / `deinit` are lifecycle,
 * properties — computed included — are accessors/data, an enum case is data,
 * and a nested type declaration is judged on its own. Members are read by
 * child NODE TYPE, never `childForFieldName`: this grammar registers one child
 * under two field names and materialization keeps only one (the
 * `domains/language` parity hazard), so every field read here would be one
 * grammar bump away from extracting nothing.
 */

import type { AstNode } from "../../../../../contracts/types/ast.js";
import {
  isBehaviourFreeClassBody,
  typeAbstractnessFacetPass,
  type ExtractionFacetPass,
} from "../../../kernel/index.js";
import { swiftTypeDeclarationKind } from "../walker.js";

/** The `class_body` / `enum_class_body` of a declaration, found by node type — see the module doc. */
function bodyOf(node: AstNode): AstNode | null {
  return node.namedChildren.find((c) => c.type === "class_body" || c.type === "enum_class_body") ?? null;
}

/** Whether one type-body member declares behaviour; see the module doc. */
function classMemberDeclaresBehaviour(member: AstNode): boolean {
  switch (member.type) {
    case "function_declaration":
      return true;
    case "property_declaration":
      return member.namedChildren.some((c) => c.type === "lambda_literal");
    default:
      return false;
  }
}

export const swiftTypeAbstractnessFacetPass: ExtractionFacetPass = typeAbstractnessFacetPass((node) => {
  const kind = swiftTypeDeclarationKind(node);
  if (kind === null || kind === "extension") return null;
  if (kind === "protocol") return "abstract";
  return isBehaviourFreeClassBody(bodyOf(node), classMemberDeclaresBehaviour) ? null : "concrete";
});
