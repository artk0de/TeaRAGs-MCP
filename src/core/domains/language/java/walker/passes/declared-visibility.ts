/**
 * Java declared visibility (bd tea-rags-mcp-jwjyr.1), read by the kernel's
 * declared-visibility facet for every declaration `javaNameOf` names — class /
 * interface / enum, method, constructor:
 *
 *   | declaration                              | visibility  |
 *   | ---------------------------------------- | ----------- |
 *   | `private`                                | private     |
 *   | `protected`                              | protected   |
 *   | `public`                                 | public      |
 *   | no modifier, member of an interface body | public      |
 *   | no modifier anywhere else                | (none)      |
 *
 * Package-private has no slot in the three-value union and is left unrecorded:
 * `public` would overstate its reach and `private` would let an access rule drop
 * a legal same-package caller. An interface member with no modifier is
 * implicitly public by the language, so that one IS provable.
 */

import type { AstNode } from "../../../../../contracts/types/ast.js";
import {
  declaredVisibilityFacetPass,
  type DeclaredVisibility,
  type DeclaredVisibilityReader,
  type ExtractionFacetPass,
} from "../../../kernel/index.js";
import { javaNameOf } from "../name-of.js";

const ACCESS_KEYWORDS: ReadonlySet<string> = new Set(["private", "protected", "public"]);

function javaVisibility(node: AstNode): DeclaredVisibility | null {
  const modifiers = node.children.find((c) => c.type === "modifiers");
  const keyword = modifiers?.children.find((c) => ACCESS_KEYWORDS.has(c.type))?.type;
  if (keyword === "private" || keyword === "protected" || keyword === "public") return keyword;
  return node.parent?.type === "interface_body" ? "public" : null;
}

export const readJavaDeclaredVisibility: DeclaredVisibilityReader = (node) => {
  const named = javaNameOf(node);
  if (named === null) return null;
  const visibility = javaVisibility(node);
  return visibility === null ? null : { name: named.name, visibility };
};

export const javaDeclaredVisibilityFacetPass: ExtractionFacetPass =
  declaredVisibilityFacetPass(readJavaDeclaredVisibility);
