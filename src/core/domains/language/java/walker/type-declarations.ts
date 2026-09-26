/**
 * Java type/constant declaration readings (bd tea-rags-mcp-vi0wx, spec §1b) —
 * the per-node questions the walker's single declaration traversal asks while
 * it builds `FileExtraction.typeDeclarations`:
 *
 *   | declaration                                   | symbolKind |
 *   | --------------------------------------------- | ---------- |
 *   | `class` / `record`                            | class      |
 *   | `interface` / `@interface`                    | interface  |
 *   | `enum`                                        | enum       |
 *   | `static final` field of a type body           | constant   |
 *   | any field of an interface / `@interface` body | constant   |
 *
 * Interface and annotation fields are implicitly `static final`; tree-sitter
 * parses them as `constant_declaration`, never as `field_declaration`.
 */

import type { AstNode } from "../../../../contracts/types/ast.js";

/** Nodes whose children are a type's member declarations. */
const TYPE_BODY_TYPES: ReadonlySet<string> = new Set([
  "class_body",
  "interface_body",
  "enum_body",
  "enum_body_declarations",
  "annotation_type_body",
]);

export function isJavaTypeBody(node: AstNode): boolean {
  return TYPE_BODY_TYPES.has(node.type);
}

/**
 * The names a field-shaped member declares as constants: every declarator of an
 * interface / annotation `constant_declaration`, and of a `field_declaration`
 * whose modifiers carry both `static` and `final`. Empty for anything else.
 */
export function javaConstantNames(member: AstNode): string[] {
  if (member.type !== "constant_declaration" && member.type !== "field_declaration") return [];
  if (member.type === "field_declaration" && !isStaticFinal(member)) return [];
  const names: string[] = [];
  for (const declarator of member.children) {
    if (declarator.type !== "variable_declarator") continue;
    const name = declarator.childForFieldName("name");
    if (name) names.push(name.text);
  }
  return names;
}

function isStaticFinal(field: AstNode): boolean {
  const modifiers = field.children.find((c) => c.type === "modifiers");
  if (!modifiers) return false;
  const keywords = new Set(modifiers.children.map((c) => c.type));
  return keywords.has("static") && keywords.has("final");
}

/**
 * The supertypes a type declaration names, in clause order: the `extends`
 * superclass first, then the `implements` (class / enum / record) or `extends`
 * (interface) list. Generic arguments are dropped (`Comparable<R>` →
 * `Comparable`); a qualified name keeps its qualifier (`java.io.Serializable`).
 */
export function javaConformedTypeNames(declaration: AstNode): string[] {
  const out: string[] = [];
  const superclass = declaration.childForFieldName("superclass");
  if (superclass) {
    for (const child of superclass.children) pushTypeName(child, out);
  }
  const clause =
    declaration.childForFieldName("interfaces") ?? declaration.children.find((c) => c.type === "extends_interfaces");
  const list = clause?.children.find((c) => c.type === "type_list");
  if (list) for (const child of list.children) pushTypeName(child, out);
  return out;
}

function pushTypeName(typeNode: AstNode, out: string[]): void {
  if (typeNode.type === "type_identifier" || typeNode.type === "scoped_type_identifier") {
    out.push(typeNode.text);
    return;
  }
  if (typeNode.type === "generic_type") {
    const base = typeNode.children.find((c) => c.type === "type_identifier" || c.type === "scoped_type_identifier");
    if (base) out.push(base.text);
  }
}
