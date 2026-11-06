/**
 * Kotlin `LanguageKernel`. One grammar, one extension (`.kt`).
 *
 * Nested types join with `.`. A `fun` in a companion object is class-level
 * (`.`); a `fun` in any other type body is an instance method (`#`); a
 * top-level `fun` is not a method. `classifyMethod` gates that on the
 * anonymous `fun` keyword so TypeScript and Swift `function_declaration`
 * nodes are untouched. `companion_object` is a scope container so a named
 * companion accumulates `Widget.Factory`; an unnamed one has no `name`
 * field and adds no segment.
 */

import type { AstNode } from "../../../contracts/types/ast.js";
import type { LanguageKernel } from "../../../contracts/types/language.js";
import { classifyMethod } from "../../../primitives/ids/index.js";

interface TreeSitterLanguageModule {
  default?: unknown;
  [key: string]: unknown;
}

export const kotlinKernel: LanguageKernel = {
  loadModule: async () => import("@tree-sitter-grammars/tree-sitter-kotlin"),
  grammarPackage: "@tree-sitter-grammars/tree-sitter-kotlin",
  extractLanguage: (mod: TreeSitterLanguageModule) => mod.default ?? mod,
  scopeSeparator: ".",
  scopeContainerTypes: ["class_declaration", "object_declaration", "companion_object"],
  disambiguateOverloads: true,
  isInstanceMethod: (node: AstNode) => classifyMethod(node) === "instance",
};
