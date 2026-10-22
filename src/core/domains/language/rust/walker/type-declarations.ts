/**
 * Rust type and constant declaration facts (spec §1b, W3c) — the
 * `FileExtraction.typeDeclarations` channel, read by the naming lexicon's type
 * roles and by the Rust resolver's declaration and trait-impl reads.
 *
 *   | node                                  | symbolKind |
 *   | ------------------------------------- | ---------- |
 *   | `struct_item`, `union_item`           | class      |
 *   | `enum_item`                           | enum       |
 *   | `trait_item`                          | interface  |
 *   | `type_item` (`type X = …`)            | type_alias |
 *   | `const_item`, `static_item`           | constant   |
 *   | `mod_item` with a body (`mod m { }`)  | module     |
 *
 * The walker's one symbol-kind traversal calls {@link rustTypeDeclarationFactOf}
 * per node with the scope it composes, so a fact's typeId is the node's name
 * under its enclosing `mod` / trait / `impl` type joined with `::` — the id its
 * chunk carries (`inner::Local`), and for a const that has no chunk, the id it
 * would carry (`Pool::SIZE`).
 *
 * Deliberately not facts:
 * - anything under a {@link isRustLocalScopeBoundary} node — a `fn` body, a
 *   closure, a const/static initializer: those declarations are locals;
 * - `type X = …` in an `impl` block — only a trait impl may hold one, and its
 *   name is the trait's (`type Item`, `type Output`), not the project's;
 * - a trait's `type Item;` — an `associated_type`, not a `type X = …`;
 * - `mod m;` — the module's declaration lives in the file it names.
 *
 * `conforms` is a trait's supertraits (its `bounds` clause) in clause order,
 * generic arguments and the `for<'a>` binder dropped, lifetimes and `?Sized`
 * skipped. A struct carries none: `impl Trait for S` is not a supertype of
 * the declaration.
 *
 * A trait impl is a RE-OPENING of its self type (bd tea-rags-mcp-s3i8m): its
 * typeId is the scope name the impl's methods compose under (`X`, generics
 * stripped), `conforms` the implemented trait, and `selfConstraints` the
 * impl's line span with what `Self` is bound by inside it. A blanket impl
 * whose self type is its own type parameter (`impl<T: B> Tr for T`) lists the
 * impl's `genericParameters` and that parameter's bounds, inline and `where`,
 * as `selfConstraints.types`; a concrete self type carries none. An inherent
 * `impl X` names no trait and is no fact.
 */

import type { AstNode } from "../../../../contracts/types/ast.js";
import type { TypeDeclarationFact } from "../../../../contracts/types/codegraph-extraction.js";
import { rustDeclaredEnumVariantFields, rustDeclaredStructFields } from "./field-types.js";
import { rustNameOf } from "./name-of.js";
import { rustGenericParameters } from "./return-types.js";
import { rustOwnerItemOf, symbolKindOf } from "./symbol-kind.js";

const DECLARATION_NODE_TYPES: ReadonlySet<string> = new Set([
  "struct_item",
  "union_item",
  "enum_item",
  "trait_item",
  "type_item",
  "const_item",
  "static_item",
  "mod_item",
]);

const LOCAL_SCOPE_BOUNDARIES: ReadonlySet<string> = new Set([
  "function_item",
  "closure_expression",
  "const_item",
  "static_item",
]);

/** Declarations inside `node` are locals — it is a `fn`, a closure or a const/static initializer. */
export function isRustLocalScopeBoundary(node: AstNode): boolean {
  return LOCAL_SCOPE_BOUNDARIES.has(node.type);
}

/** The fact `node` declares under `scope` (its enclosing names), or null when it declares none. */
export function rustTypeDeclarationFactOf(node: AstNode, scope: readonly string[]): TypeDeclarationFact | null {
  if (node.type === "impl_item") return rustTraitImplFactOf(node, scope);
  if (!DECLARATION_NODE_TYPES.has(node.type)) return null;
  if (node.type === "mod_item" && node.childForFieldName("body") === null) return null;
  if (node.type === "type_item" && rustOwnerItemOf(node) === "impl_item") return null;
  const name = node.childForFieldName("name")?.text;
  const symbolKind = symbolKindOf(node.type, { ownerItem: rustOwnerItemOf(node) });
  if (name === undefined || symbolKind === undefined) return null;
  const conforms = node.type === "trait_item" ? rustSupertraitNames(node) : [];
  const genericParameters = rustGenericParameters(node);
  const { genericFieldParameters, fieldTypeArguments } = rustDeclaredStructFields(node, genericParameters);
  // A variant payload's channels live on the enum's own fact, keyed
  // `<Variant>::<field>` — the fact carries the generic parameters they name.
  for (const [variant, declared] of rustDeclaredEnumVariantFields(node, genericParameters)) {
    for (const [field, parameter] of Object.entries(declared.genericFieldParameters)) {
      genericFieldParameters[`${variant}::${field}`] = parameter;
    }
    for (const [field, typeArguments] of Object.entries(declared.fieldTypeArguments)) {
      fieldTypeArguments[`${variant}::${field}`] = typeArguments;
    }
  }
  return {
    typeId: [...scope, name].join("::"),
    symbolKind,
    line: node.startPosition.row + 1,
    reopens: false,
    ...(conforms.length > 0 ? { conforms } : {}),
    ...(genericParameters.length > 0 ? { genericParameters } : {}),
    ...(Object.keys(genericFieldParameters).length > 0 ? { genericFieldParameters } : {}),
    ...(Object.keys(fieldTypeArguments).length > 0 ? { fieldTypeArguments } : {}),
  };
}

/** `impl Tr for X` as a re-opening of `X` — see the module doc. Null for an inherent impl. */
function rustTraitImplFactOf(node: AstNode, scope: readonly string[]): TypeDeclarationFact | null {
  const trait = node.childForFieldName("trait");
  const selfName = rustNameOf(node)?.name;
  const traitName = trait ? rustBoundTypeName(trait) : null;
  if (traitName === null || selfName === undefined) return null;
  const genericParameters = rustGenericParameters(node);
  const genericSelf =
    node.childForFieldName("type")?.type === "type_identifier" && genericParameters.includes(selfName);
  return {
    typeId: [...scope, selfName].join("::"),
    symbolKind: "class",
    line: node.startPosition.row + 1,
    reopens: true,
    conforms: [traitName],
    ...(genericSelf ? { genericParameters } : {}),
    selfConstraints: {
      types: genericSelf ? rustTypeParameterBounds(node, selfName) : [],
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
    },
  };
}

/** The trait bounds an `impl<…>` puts on its type parameter `name`: inline `T: A + B`, then `where T: C`. */
function rustTypeParameterBounds(node: AstNode, name: string): string[] {
  const out: string[] = [];
  const pushBounds = (bounds: AstNode | null | undefined): void => {
    for (const bound of bounds?.children ?? []) {
      const boundName = rustBoundTypeName(bound);
      if (boundName !== null) out.push(boundName);
    }
  };
  for (const parameter of node.childForFieldName("type_parameters")?.namedChildren ?? []) {
    if (parameter.type === "type_parameter" && parameter.childForFieldName("name")?.text === name) {
      pushBounds(parameter.childForFieldName("bounds"));
    }
  }
  const whereClause = node.namedChildren.find((child) => child.type === "where_clause");
  for (const predicate of whereClause?.namedChildren ?? []) {
    if (predicate.type === "where_predicate" && predicate.childForFieldName("left")?.text === name) {
      pushBounds(predicate.childForFieldName("bounds"));
    }
  }
  return out;
}

function rustSupertraitNames(trait: AstNode): string[] {
  const bounds = trait.childForFieldName("bounds");
  if (!bounds) return [];
  const out: string[] = [];
  for (const bound of bounds.children) {
    const name = rustBoundTypeName(bound);
    if (name !== null) out.push(name);
  }
  return out;
}

/** `Base` / `fmt::Debug` as written; `Handler<Req>` → `Handler`; `for<'a> Visit<'a>` → `Visit`; else null. */
function rustBoundTypeName(bound: AstNode): string | null {
  if (bound.type === "type_identifier" || bound.type === "scoped_type_identifier") return bound.text;
  if (bound.type === "generic_type" || bound.type === "higher_ranked_trait_bound") {
    const inner = bound.childForFieldName("type");
    return inner ? rustBoundTypeName(inner) : null;
  }
  return null;
}
