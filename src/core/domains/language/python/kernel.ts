/**
 * Python `LanguageKernel` — parser loading + the cross-engine detection +
 * namespace config shared by the Python chunker and walker.
 *
 * Behaviour-preserving extraction of the fields the legacy adapter's
 * `kernelFrom(LANGUAGE_DEFINITIONS.python)` produced (spec §1, §3):
 *   - `loadModule` / `extractLanguage` — same lazy `tree-sitter-python` import;
 *     `extractLanguage` is `mod.default ?? mod` (the Python grammar is a plain
 *     default export). One grammar, one extension — `.py` maps to language
 *     "python" (`LANGUAGE_MAP`) and both engines share it.
 *   - `scopeSeparator: "."` — Python nested-class join (`Outer.Inner#method`),
 *     matching the codegraph `.py` entry's explicit `"."` (also the default in
 *     `composeParentSymbol`, set explicitly here for clarity). Methods STILL use
 *     `#`/`.` via `SymbolIdComposer`.
 *   - `scopeContainerTypes: ["class_definition"]` — so the chunker accumulates
 *     the full scope qualifier for nested-class leaf methods, matching
 *     `LANGUAGE_DEFINITIONS.python` 1:1.
 *   - `disambiguateOverloads` — UNSET for Python (mirrors
 *     `LANGUAGE_DEFINITIONS.python`, which declares none).
 *   - `isInstanceMethod` — derived from `classifyMethod` (infra/symbolid): a
 *     `function_definition` inside a class without `@classmethod`/`@staticmethod`
 *     is an instance method; a decorated one is class-level. Non-method nodes
 *     yield `null` → not "instance" → `false`, identical to the per-engine
 *     static checks.
 */

import type { AstNode } from "../../../contracts/types/ast.js";
import type { LanguageKernel } from "../../../contracts/types/language.js";
import { classifyMethod } from "../../../infra/symbolid/index.js";

interface TreeSitterLanguageModule {
  default?: unknown;
  [key: string]: unknown;
}

export const pythonKernel: LanguageKernel = {
  loadModule: async () => import("tree-sitter-python") as Promise<TreeSitterLanguageModule>,
  extractLanguage: (mod: TreeSitterLanguageModule) => mod.default ?? mod,
  scopeSeparator: ".",
  scopeContainerTypes: ["class_definition"],
  isInstanceMethod: (node: AstNode) => classifyMethod(node) === "instance",
};
