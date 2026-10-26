import { createIdentifierRecord } from "../../../../contracts/identifier-record.js";
import type { AstNode } from "../../../../contracts/types/ast.js";
import { rustDeclaredTypeRef, rustGenericHead } from "./return-types.js";

/**
 * Explicitly declared struct fields: named (`f: T`) and tuple-struct positional
 * (`struct W(T)` → field `0`, the name `self.0` spells). The flat channels
 * cannot encode nested type arguments, so a nested argument (`Arc<Mutex<T>>`)
 * is recorded as `null` — the field's head stays typed, its unknown argument
 * is never guessed (bd tea-rags-mcp-2g2og.24).
 */
export function rustDeclaredStructFields(node: AstNode, genericParameters: readonly string[]) {
  return rustDeclaredFields(node.type === "struct_item" ? rustStructFieldNodes(node) : [], genericParameters);
}

/**
 * An enum's variant payloads, per variant name (bd tea-rags-mcp-s3i8m Task
 * 1b): `A(T)` → field `0`, `B { peer: P }` → field `peer`, recorded exactly
 * like struct fields so a pattern `Enum::A(w)` folds to the payload type. A
 * unit variant records nothing; a variant name repeated is dropped.
 */
export function rustDeclaredEnumVariantFields(
  node: AstNode,
  genericParameters: readonly string[],
): Map<string, ReturnType<typeof rustDeclaredFields>> {
  const variants = new Map<string, ReturnType<typeof rustDeclaredFields>>();
  if (node.type !== "enum_item") return variants;
  const repeated = new Set<string>();
  for (const variant of node.childForFieldName("body")?.namedChildren ?? []) {
    const name = variant.type === "enum_variant" ? variant.childForFieldName("name")?.text : undefined;
    if (name === undefined) continue;
    if (variants.has(name) || repeated.has(name)) {
      variants.delete(name);
      repeated.add(name);
      continue;
    }
    const payloadFields = rustDeclaredFields(rustStructFieldNodes(variant), genericParameters);
    if (Object.keys(payloadFields.fields).length > 0) variants.set(name, payloadFields);
  }
  return variants;
}

function rustDeclaredFields(
  fieldNodes: readonly { name: string; typeNode: AstNode | null }[],
  genericParameters: readonly string[],
) {
  const fields = createIdentifierRecord<string>();
  const genericFieldParameters = createIdentifierRecord<string>();
  const fieldTypeArguments = createIdentifierRecord<readonly (string | null)[]>();
  const seen = new Set<string>();
  for (const { name, typeNode } of fieldNodes) {
    if (seen.has(name)) {
      delete fields[name];
      delete genericFieldParameters[name];
      delete fieldTypeArguments[name];
      continue;
    }
    seen.add(name);
    const declaredType = rustDeclaredTypeRef(typeNode);
    if (declaredType === undefined) {
      const generic = rustGenericHead(typeNode);
      if (generic === undefined) continue;
      fields[name] = generic.name;
      fieldTypeArguments[name] = Array.from({ length: generic.argumentCount }, () => null);
      continue;
    }
    if (declaredType.form !== "instance") continue;
    fields[name] = declaredType.name;
    if (genericParameters.includes(declaredType.name) && declaredType.args === undefined) {
      genericFieldParameters[name] = declaredType.name;
    }
    if (declaredType.args !== undefined) {
      fieldTypeArguments[name] = declaredType.args.map((arg) =>
        arg.form === "instance" && arg.args === undefined ? arg.name : null,
      );
    }
  }
  return { fields, genericFieldParameters, fieldTypeArguments };
}

/** Each field's access name and declared type node — named fields by name, tuple fields by position (a struct or an enum variant). */
function rustStructFieldNodes(node: AstNode): { name: string; typeNode: AstNode | null }[] {
  const body = node.childForFieldName("body");
  if (body?.type === "ordered_field_declaration_list") {
    return body.namedChildren
      .filter((child) => child.type !== "visibility_modifier" && child.type !== "attribute_item")
      .map((typeNode, index) => ({ name: String(index), typeNode }));
  }
  const out: { name: string; typeNode: AstNode | null }[] = [];
  for (const field of body?.namedChildren ?? []) {
    if (field.type !== "field_declaration") continue;
    const name = field.childForFieldName("name")?.text;
    if (name !== undefined) out.push({ name, typeNode: field.childForFieldName("type") });
  }
  return out;
}
