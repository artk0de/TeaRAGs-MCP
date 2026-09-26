/**
 * Go type and constant declaration facts (spec §1b, W3c) — the
 * `FileExtraction.typeDeclarations` channel, read by the naming lexicon's type
 * roles. For Go the facts are naming data only: the Go resolver does not read
 * them, so they never change call resolution.
 *
 *   | node                               | symbolKind |
 *   | ---------------------------------- | ---------- |
 *   | `type_spec` (struct, defined type) | class      |
 *   | `type_spec` over `interface_type`  | interface  |
 *   | `type_alias` (`type X = Y`)        | type_alias |
 *   | each name of a `const_spec`        | constant   |
 *
 * The type kinds are the chunk's kinds ({@link symbolKindOf}), so the two
 * channels cannot disagree. Go declares no nested types (a type inside a
 * function body is local, and locals are not facts), so a `typeId` is the bare
 * name — the symbolId Go composes for the type.
 *
 * `conforms` carries the EMBEDDED types of a struct or interface. Go has no
 * `extends`: embedding is its closest supertype relation — an embedding struct
 * gets the embedded type's promoted members, an embedding interface its method
 * set. A union or `~T` element of a constraint interface is a type set, not an
 * embedding, and is not listed.
 */
import type { AstNode } from "../../../../contracts/types/ast.js";
import type { TypeDeclarationFact } from "../../../../contracts/types/codegraph-extraction.js";
import { goTypeSpecSymbolOf } from "../naming.js";
import { symbolKindOf } from "./symbol-kind.js";

/** The facts `node` declares when it sits at package level; empty for any other node. */
export function goTypeDeclarationFactsOf(node: AstNode): TypeDeclarationFact[] {
  if (node.type === "const_spec") {
    const line = node.startPosition.row + 1;
    // A spec's names are its `identifier` children; its type is a
    // `type_identifier` and its values sit in an `expression_list`.
    return node.namedChildren
      .filter((name) => name.type === "identifier" && name.text !== "_")
      .map((name): TypeDeclarationFact => ({ typeId: name.text, symbolKind: "constant", line, reopens: false }));
  }
  if (node.type !== "type_spec" && node.type !== "type_alias") return [];
  const spec = goTypeSpecSymbolOf(node);
  const body = node.childForFieldName("type");
  const symbolKind = symbolKindOf(node.type, { typeBody: body?.type });
  if (spec === null || symbolKind === undefined) return [];
  const conforms = node.type === "type_spec" && body ? goEmbeddedTypeNames(body) : [];
  return [
    {
      typeId: spec.name,
      symbolKind,
      line: node.startPosition.row + 1,
      reopens: false,
      ...(conforms.length > 0 ? { conforms } : {}),
    },
  ];
}

/** Embedded types of a struct / interface body, in source order; `[]` for any other body. */
function goEmbeddedTypeNames(body: AstNode): string[] {
  const out: string[] = [];
  if (body.type === "struct_type") {
    for (const list of body.namedChildren) {
      if (list.type !== "field_declaration_list") continue;
      for (const field of list.namedChildren) {
        if (field.type !== "field_declaration" || field.childForFieldName("name") !== null) continue;
        const name = goEmbeddedTypeName(field.childForFieldName("type"));
        if (name !== undefined) out.push(name);
      }
    }
  } else if (body.type === "interface_type") {
    for (const element of body.namedChildren) {
      if (element.type !== "type_elem" || element.namedChildren.length !== 1) continue;
      const name = goEmbeddedTypeName(element.namedChildren[0]);
      if (name !== undefined) out.push(name);
    }
  }
  return out;
}

/**
 * The name an embedded type is written with — `Base`, `io.Reader` — with the
 * generic arguments dropped (`Cache[string]` → `Cache`). A struct's `*Logger`
 * parses as the bare `type_identifier`, so the pointer is already gone.
 */
function goEmbeddedTypeName(type: AstNode | null | undefined): string | undefined {
  if (!type) return undefined;
  if (type.type === "type_identifier" || type.type === "qualified_type") return type.text;
  if (type.type === "generic_type") return goEmbeddedTypeName(type.childForFieldName("type"));
  return undefined;
}
