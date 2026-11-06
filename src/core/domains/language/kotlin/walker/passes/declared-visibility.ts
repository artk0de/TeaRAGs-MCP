/**
 * Kotlin declared visibility, read for every declaration `kotlinNameOf` names.
 *
 *   | declaration            | visibility |
 *   | ---------------------- | ---------- |
 *   | `private`              | private    |
 *   | `protected`            | protected  |
 *   | `public`               | public     |
 *   | `internal`             | (none)     |
 *   | no modifier            | public     |
 *
 * Kotlin's default visibility is public, unlike Java's package-private, so an
 * absent modifier is a provable `public`. `internal` has no slot in the
 * three-value union: recording `public` would overstate its reach and
 * `private` would hide a legal same-module caller, so it stays unrecorded.
 */

import type { AstNode } from "../../../../../contracts/types/ast.js";
import {
  declaredVisibilityFacetPass,
  type DeclaredVisibility,
  type DeclaredVisibilityReader,
  type ExtractionFacetPass,
} from "../../../kernel/index.js";
import { kotlinNameOf } from "../name-of.js";

function kotlinVisibility(node: AstNode): DeclaredVisibility | null {
  const modifiers = node.children.find((child) => child.type === "modifiers");
  const keyword = modifiers?.children.find((child) => child.type === "visibility_modifier")?.text;
  if (keyword === "private" || keyword === "protected" || keyword === "public") return keyword;
  if (keyword === "internal") return null;
  return "public";
}

export const readKotlinDeclaredVisibility: DeclaredVisibilityReader = (node) => {
  const named = kotlinNameOf(node);
  if (named === null) return null;
  const visibility = kotlinVisibility(node);
  return visibility === null ? null : { name: named.name, visibility };
};

export const kotlinDeclaredVisibilityFacetPass: ExtractionFacetPass =
  declaredVisibilityFacetPass(readKotlinDeclaredVisibility);
