/**
 * Swift `LanguageKernel` — parser loading + the cross-engine namespace config
 * shared by the Swift chunker (and, in tier 2, its walker).
 *
 *   - `loadModule` / `extractLanguage` — lazy `tree-sitter-swift` import;
 *     `extractLanguage` is `mod.default ?? mod` (the Swift grammar is a plain
 *     default export). One grammar, one extension — `.swift` maps to language
 *     "swift" (`LANGUAGE_MAP`).
 *   - `scopeSeparator: "."` — Swift nested-type join (`Outer.Inner#method`),
 *     matching Java (also the default in `composeParentSymbol`, set explicitly
 *     for clarity). Methods STILL use `#`/`.` via `SymbolIdComposer` per
 *     `.claude/rules/symbolid-convention.md`.
 *   - `scopeContainerTypes` — `class_declaration` / `protocol_declaration`.
 *     tree-sitter-swift parses class AND struct AND enum AND extension AND
 *     actor declarations as `class_declaration` (the keyword is an anonymous
 *     child: `struct` / `enum` / `extension` / `actor`), so ONE node type
 *     covers every nominal-type container. An extension's methods therefore
 *     attribute to the extended type (`Vehicle#honk`), which is Swift's own
 *     semantics. Members are extracted as leaf chunks; `struct` / `enum` bodies
 *     do not nest method chunks of their own.
 *   - `disambiguateOverloads: true` — Swift methods overload freely (same name,
 *     distinct parameter lists), and protocol + extension conformances can
 *     repeat a name across declarations. Each overload carries a distinct body,
 *     so duplicate composed symbolIds inside one file are suffixed `~N` instead
 *     of deduped (Java precedent, bd tea-rags-mcp-a466).
 *   - `isInstanceMethod` — derived from `classifyMethod` (infra/symbolid): a
 *     `function_declaration` / `protocol_function_declaration` carrying a
 *     `static` / `class` modifier is class-level; without one it is an instance
 *     method; `init_declaration` is always instance-bound. Non-method nodes
 *     yield `null` → `false`.
 */

import type { AstNode } from "../../../contracts/types/ast.js";
import type { LanguageKernel } from "../../../contracts/types/language.js";
import { classifyMethod } from "../../../infra/symbolid/index.js";

interface TreeSitterLanguageModule {
  default?: unknown;
  [key: string]: unknown;
}

export const swiftKernel: LanguageKernel = {
  loadModule: async () => import("tree-sitter-swift"),
  extractLanguage: (mod: TreeSitterLanguageModule) => mod.default ?? mod,
  scopeSeparator: ".",
  scopeContainerTypes: ["class_declaration", "protocol_declaration"],
  disambiguateOverloads: true,
  isInstanceMethod: (node: AstNode) => classifyMethod(node) === "instance",
};
