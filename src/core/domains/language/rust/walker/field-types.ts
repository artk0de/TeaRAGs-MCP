import { createIdentifierRecord } from "../../../../contracts/identifier-record.js";
import type { AstNode } from "../../../../contracts/types/ast.js";
import { rustDeclaredTypeRef } from "./return-types.js";

/** Named, explicitly declared struct fields only; the flat channels cannot encode nested type arguments. */
export function rustDeclaredStructFields(node: AstNode, genericParameters: readonly string[]) {
  const fields = createIdentifierRecord<string>();
  const genericFieldParameters = createIdentifierRecord<string>();
  const fieldTypeArguments = createIdentifierRecord<readonly (string | null)[]>();
  if (node.type !== "struct_item") return { fields, genericFieldParameters, fieldTypeArguments };
  const seen = new Set<string>();
  for (const field of node.childForFieldName("body")?.namedChildren ?? []) {
    if (field.type !== "field_declaration") continue;
    const name = field.childForFieldName("name")?.text;
    if (name === undefined) continue;
    if (seen.has(name)) {
      delete fields[name];
      delete genericFieldParameters[name];
      delete fieldTypeArguments[name];
      continue;
    }
    seen.add(name);
    const declared = rustDeclaredTypeRef(field.childForFieldName("type"));
    if (declared?.form !== "instance") continue;
    if (declared.args?.some((arg) => arg.form !== "instance" || arg.args !== undefined)) continue;
    fields[name] = declared.name;
    if (genericParameters.includes(declared.name) && declared.args === undefined) {
      genericFieldParameters[name] = declared.name;
    }
    if (declared.args !== undefined) {
      fieldTypeArguments[name] = declared.args.map((arg) => (arg.form === "instance" ? arg.name : null));
    }
  }
  return { fields, genericFieldParameters, fieldTypeArguments };
}
