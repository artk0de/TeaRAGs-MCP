/**
 * Ruby `LanguageKernel` — parser loading + the cross-engine detection +
 * namespace config shared by the Ruby chunker and walker.
 *
 * Behaviour-preserving extraction of the fields the legacy adapter's
 * `kernelFrom(LANGUAGE_DEFINITIONS.ruby)` produced (spec §1, §3):
 *   - `loadModule` / `extractLanguage` — same lazy `tree-sitter-ruby` import.
 *   - `scopeSeparator: "::"` — Ruby namespace join (`module A; module B; class C`
 *     → `A::B::C`). Methods STILL use `#`/`.` via `SymbolIdComposer`.
 *   - `scopeContainerTypes` — `class` / `module` / `singleton_class`, so the
 *     chunker accumulates the full scope qualifier for nested-namespace leaf
 *     methods (bd tea-rags-mcp-bdvm).
 *   - `isInstanceMethod` — derived from `classifyMethod` (infra/symbolid): a
 *     node is an instance method iff `classifyMethod(node) === "instance"`.
 *     Non-method nodes yield `null` → not "instance" → `false`, identical to
 *     the per-engine static checks.
 */

import type Parser from "tree-sitter";

import type { LanguageKernel } from "../../../contracts/types/language.js";
import { classifyMethod } from "../../../infra/symbolid/index.js";

interface TreeSitterLanguageModule {
  default?: unknown;
  typescript?: unknown;
  [key: string]: unknown;
}

export const rubyKernel: LanguageKernel = {
  loadModule: async () => import("tree-sitter-ruby") as Promise<TreeSitterLanguageModule>,
  extractLanguage: (mod: TreeSitterLanguageModule) => mod.default ?? mod,
  scopeSeparator: "::",
  scopeContainerTypes: ["class", "module", "singleton_class"],
  isInstanceMethod: (node: Parser.SyntaxNode) => classifyMethod(node) === "instance",
};
