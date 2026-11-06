/**
 * PHP declared visibility, read for every declaration `phpNameOf` names.
 *
 *   | declaration                         | visibility |
 *   | ----------------------------------- | ---------- |
 *   | `private` / `protected` / `public`  | that word  |
 *   | method with no visibility keyword   | public     |
 *   | class / interface / trait           | (none)     |
 *
 * A method with no modifier is public by the language, including an interface
 * method. A class has no visibility to record. `var` properties are left
 * unrecorded: `var` is not one of the three keywords.
 */

import type { AstNode } from "../../../../../contracts/types/ast.js";
import {
  declaredVisibilityFacetPass,
  type DeclaredVisibility,
  type DeclaredVisibilityReader,
  type ExtractionFacetPass,
} from "../../../kernel/index.js";
import { phpNameOf } from "../name-of.js";

function phpVisibility(node: AstNode): DeclaredVisibility | null {
  const keyword = node.children.find((child) => child.type === "visibility_modifier")?.text;
  if (keyword === "private" || keyword === "protected" || keyword === "public") return keyword;
  return node.type === "method_declaration" ? "public" : null;
}

export const readPhpDeclaredVisibility: DeclaredVisibilityReader = (node) => {
  const named = phpNameOf(node);
  if (named === null) return null;
  const visibility = phpVisibility(node);
  return visibility === null ? null : { name: named.name, visibility };
};

export const phpDeclaredVisibilityFacetPass: ExtractionFacetPass =
  declaredVisibilityFacetPass(readPhpDeclaredVisibility);
