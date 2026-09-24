/**
 * Swift declared visibility (bd tea-rags-mcp-jwjyr.1), read by the kernel's
 * declared-visibility facet for every declaration `swiftNameOf` names — a type
 * (`class_declaration` covers class / struct / enum / extension / actor), a
 * protocol, a func, an init:
 *
 *   | modifier                                   | visibility |
 *   | ------------------------------------------ | ---------- |
 *   | `private`, `fileprivate`                   | private    |
 *   | `internal`, `public`, `open`, none         | public     |
 *
 * Both file-bounded levels map to private: the union has one slot, and a
 * `private` member is reachable from same-file extensions of its type, so the
 * only safe reading of either is "file-bounded". `internal` — the default — is
 * module-wide, which is public for every consumer inside one project.
 *
 * A setter-only restriction (`private(set)`) is not an access level of the
 * declaration and is ignored: only a modifier spelled exactly `private` or
 * `fileprivate` counts. Members inside a `private extension` inherit its level
 * in Swift but are recorded public here — the safe direction, since public never
 * lets an access rule drop an edge.
 */

import type { AstNode } from "../../../../../contracts/types/ast.js";
import {
  declaredVisibilityFacetPass,
  type DeclaredVisibility,
  type DeclaredVisibilityReader,
  type ExtractionFacetPass,
} from "../../../kernel/index.js";
import { swiftNameOf } from "../name-of.js";

const FILE_BOUNDED_LEVELS: ReadonlySet<string> = new Set(["private", "fileprivate"]);

export function swiftVisibility(node: AstNode): DeclaredVisibility {
  const modifiers = node.children.find((c) => c.type === "modifiers");
  const fileBounded = modifiers?.children.some(
    (c) => c.type === "visibility_modifier" && FILE_BOUNDED_LEVELS.has(c.text),
  );
  return fileBounded === true ? "private" : "public";
}

export const readSwiftDeclaredVisibility: DeclaredVisibilityReader = (node) => {
  const named = swiftNameOf(node);
  if (named === null) return null;
  return { name: named.name, visibility: swiftVisibility(node) };
};

export const swiftDeclaredVisibilityFacetPass: ExtractionFacetPass =
  declaredVisibilityFacetPass(readSwiftDeclaredVisibility);
