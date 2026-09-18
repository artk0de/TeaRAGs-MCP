/**
 * Go struct-field facet (bd tea-rags-mcp-e6xx) — every top-level struct's
 * fields, published on the run-global `classFieldTypesByClassKey` channel so the
 * resolver can follow a receiver THROUGH a struct: Go's method promotion
 * (`engine.GET` → `RouterGroup#GET`, because `Engine` embeds `RouterGroup`) and
 * field chains (`c.writermem.reset(w)` → `responseWriter#reset`).
 *
 * A pass rather than a clause of `extractFromGoFile`: the monolith fills no
 * part of this channel, so there is nothing for the facet to win over and
 * `mergeExtraction` folds it in append-only (`walker/passes.ts`).
 *
 * Only TOP-LEVEL `type_declaration`s are read. A struct declared inside a
 * function body is not a symbol (`goNameOf` never descends), so no receiver
 * type can name it and an entry for it could only collide with a top-level
 * namesake. The map layout is owned by `../../struct-fields.ts`.
 */

import type { AstNode } from "../../../../../contracts/types/ast.js";
import type { FileExtraction } from "../../../../../contracts/types/codegraph.js";
import type { ExtractionFacetPass } from "../../../kernel/extraction-passes.js";
import { goEmbeddedFieldKey, goStructClassKey } from "../../struct-fields.js";

export const goStructFieldTypesFacetPass: ExtractionFacetPass = {
  run: (root, ctx): Partial<FileExtraction> => {
    const byClassKey: Record<string, Record<string, string>> = {};
    for (const declaration of root.children) {
      if (declaration.type !== "type_declaration") continue;
      for (const spec of declaration.children) {
        if (spec.type !== "type_spec") continue;
        const name = spec.childForFieldName("name");
        const body = spec.childForFieldName("type");
        if (!name || body?.type !== "struct_type") continue;
        byClassKey[goStructClassKey(ctx.relPath, name.text)] = collectStructFields(body);
      }
    }
    return Object.keys(byClassKey).length > 0 ? { classFieldTypesByClassKey: byClassKey } : {};
  },
};

/** One `struct_type`'s field map, named and embedded fields in declaration order. */
function collectStructFields(struct: AstNode): Record<string, string> {
  const fields: Record<string, string> = {};
  const list = struct.children.find((c) => c.type === "field_declaration_list");
  for (const field of list?.children ?? []) {
    if (field.type !== "field_declaration") continue;
    const typeNode = field.childForFieldName("type");
    if (!typeNode) continue;
    const typeName = goFieldTypeName(typeNode);
    const names = field.children.filter((c) => c.type === "field_identifier");
    if (names.length === 0) {
      // Embedded: `RouterGroup`, `*RouterGroup`, `sync.Mutex`, `Box[T]`. Its
      // implicit field name is the type's bare name, and a type that yields
      // none (an `ERROR` fragment) is no field at all.
      const implicitName = goBareTypeName(typeNode);
      if (!implicitName || !typeName) continue;
      fields[implicitName] = typeName;
      fields[goEmbeddedFieldKey(implicitName)] = typeName;
      continue;
    }
    for (const fieldName of names) {
      if (fieldName.text !== "_") fields[fieldName.text] = typeName;
    }
  }
  return fields;
}

/**
 * The recorded type of a field: the nominal type with pointers and type
 * arguments stripped, a package qualifier KEPT (`http.Request`), and `""` for a
 * type that names no single nominal type — a map, slice, func, channel,
 * interface or anonymous struct.
 */
function goFieldTypeName(node: AstNode): string {
  switch (node.type) {
    case "type_identifier":
      return node.text;
    case "qualified_type": {
      const pkg = node.childForFieldName("package");
      const name = node.childForFieldName("name");
      return pkg && name ? `${pkg.text}.${name.text}` : "";
    }
    case "pointer_type": {
      const inner = node.namedChildren[0];
      return inner ? goFieldTypeName(inner) : "";
    }
    case "generic_type": {
      const base = node.childForFieldName("type");
      return base ? goFieldTypeName(base) : "";
    }
    default:
      return "";
  }
}

/** The bare type name an embedded field is addressed by: `sync.Mutex` → `Mutex`. */
function goBareTypeName(node: AstNode): string {
  switch (node.type) {
    case "type_identifier":
      return node.text;
    case "qualified_type":
      return node.childForFieldName("name")?.text ?? "";
    case "pointer_type": {
      const inner = node.namedChildren[0];
      return inner ? goBareTypeName(inner) : "";
    }
    case "generic_type": {
      const base = node.childForFieldName("type");
      return base ? goBareTypeName(base) : "";
    }
    default:
      return "";
  }
}
