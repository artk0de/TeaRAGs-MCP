/**
 * TypeScript declared visibility (bd tea-rags-mcp-jwjyr.1) — the access level a
 * CLASS MEMBER declares, read by the kernel's declared-visibility facet:
 *
 *   | declaration                          | visibility  |
 *   | ------------------------------------ | ----------- |
 *   | `private m()` / `#m()`               | private     |
 *   | `protected m()`                      | protected   |
 *   | `public m()` / no modifier           | public      |
 *
 * Only a member whose parent is a `class_body` is read: an object-literal method
 * or a top-level function carries no access modifier at all, so there is no
 * declared level to record. The members read are exactly the ones `tsNameOf`
 * names in a class body — a `method_definition` and a function-valued
 * `public_field_definition` — so the reading joins onto a real chunk.
 *
 * JavaScript shares this reader (`jsNameOf` delegates to `tsNameOf` for these
 * nodes): its grammar has no `accessibility_modifier`, so only `#name` reads as
 * private there, which is JavaScript's whole access model.
 */

import type { AstNode } from "../../../../../contracts/types/ast.js";
import {
  declaredVisibilityFacetPass,
  type DeclaredVisibility,
  type DeclaredVisibilityReader,
  type ExtractionFacetPass,
} from "../../../kernel/index.js";
import { tsNameOf } from "../name-of.js";

const CLASS_MEMBER_TYPES: ReadonlySet<string> = new Set(["method_definition", "public_field_definition"]);

function memberVisibility(node: AstNode): DeclaredVisibility {
  if (node.childForFieldName("name")?.type === "private_property_identifier") return "private";
  const modifier = node.children.find((c) => c.type === "accessibility_modifier")?.text;
  if (modifier === "private") return "private";
  if (modifier === "protected") return "protected";
  return "public";
}

export const readEcmascriptDeclaredVisibility: DeclaredVisibilityReader = (node) => {
  if (!CLASS_MEMBER_TYPES.has(node.type) || node.parent?.type !== "class_body") return null;
  const named = tsNameOf(node);
  if (named === null || Array.isArray(named)) return null;
  return { name: named.name, visibility: memberVisibility(node) };
};

export const typescriptDeclaredVisibilityFacetPass: ExtractionFacetPass = declaredVisibilityFacetPass(
  readEcmascriptDeclaredVisibility,
);
