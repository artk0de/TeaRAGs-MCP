/**
 * Objective-C `LanguageKernel`. One grammar (`tree-sitter-objc`) for `.m` and
 * `.mm`. `.h` stays `c` in `LANGUAGE_MAP` — headers are already claimed by C.
 *
 * `scopeSeparator` is `.` for nested types. Instance methods (`-`) join with
 * `#` and class methods (`+`) with `.` via `classifyMethod`. Selectors are
 * addressed by their first keyword: the grammar's `message_expression.method`
 * field is that keyword, and `method_definition`'s first identifier matches it.
 * `disambiguateOverloads` suffixes a repeated selector in one file with `~N`.
 */

import type { AstNode } from "../../../contracts/types/ast.js";
import type { LanguageKernel } from "../../../contracts/types/language.js";
import { classifyMethod } from "../../../primitives/ids/index.js";

interface TreeSitterLanguageModule {
  default?: unknown;
  [key: string]: unknown;
}

export const objcKernel: LanguageKernel = {
  loadModule: async () => import("tree-sitter-objc"),
  grammarPackage: "tree-sitter-objc",
  extractLanguage: (mod: TreeSitterLanguageModule) => mod.default ?? mod,
  scopeSeparator: ".",
  scopeContainerTypes: ["class_implementation", "class_interface", "protocol_declaration"],
  disambiguateOverloads: true,
  isInstanceMethod: (node: AstNode) => classifyMethod(node) === "instance",
};
