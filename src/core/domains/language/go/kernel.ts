/**
 * Go `LanguageKernel` — parser loading + the cross-engine detection +
 * namespace config shared by the Go chunker and walker.
 *
 * Behaviour-preserving extraction of the fields the legacy adapter's
 * `kernelFrom(LANGUAGE_DEFINITIONS.go)` produced (spec §1, §3):
 *   - `loadModule` / `extractLanguage` — same lazy `tree-sitter-go` import;
 *     `extractLanguage` is `mod.default ?? mod` (the Go grammar is a plain
 *     default export). One grammar, one extension — `.go` maps to language
 *     "go" (`LANGUAGE_MAP`) and both engines share it.
 *   - `scopeSeparator: "."` — matching the codegraph `.go` entry's explicit
 *     `"."` (also the default in `composeParentSymbol`, set explicitly here
 *     for clarity). Go has no nested classes; methods are receiver-bound and
 *     emitted as `Receiver#Method` by the walker's `nameOf`.
 *   - `scopeContainerTypes` — UNSET for Go (mirrors `LANGUAGE_DEFINITIONS.go`,
 *     which declares none — Go has no class/method nesting to accumulate
 *     scope for).
 *   - `disambiguateOverloads` — UNSET for Go (mirrors `LANGUAGE_DEFINITIONS.go`).
 *   - `isInstanceMethod` — derived from `classifyMethod` (infra/symbolid): a
 *     `method_declaration` (which always carries a receiver) is an instance
 *     method; a top-level `function_declaration` is not, so it gets the bare
 *     `name` form. Non-method nodes yield `null` → not "instance" → `false`,
 *     identical to the per-engine static checks.
 */

import type { AstNode } from "../../../contracts/types/ast.js";
import type { LanguageKernel } from "../../../contracts/types/language.js";
import { classifyMethod } from "../../../infra/symbolid/index.js";

interface TreeSitterLanguageModule {
  default?: unknown;
  [key: string]: unknown;
}

export const goKernel: LanguageKernel = {
  loadModule: async () => import("tree-sitter-go") as Promise<TreeSitterLanguageModule>,
  extractLanguage: (mod: TreeSitterLanguageModule) => mod.default ?? mod,
  scopeSeparator: ".",
  isInstanceMethod: (node: AstNode) => classifyMethod(node) === "instance",
};
