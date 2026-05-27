/**
 * Bash `LanguageKernel` — parser loading + the cross-engine detection +
 * namespace config shared by the Bash chunker and walker.
 *
 * Behaviour-preserving extraction of the fields the legacy adapter's
 * `kernelFrom(LANGUAGE_DEFINITIONS.bash)` produced (spec §1, §3):
 *   - `loadModule` / `extractLanguage` — same lazy `tree-sitter-bash` import;
 *     `extractLanguage` is `mod.default ?? mod` (the Bash grammar is a plain
 *     default export). Two extensions, ONE grammar — `.sh` AND `.bash` both map
 *     to language "bash" (`LANGUAGE_MAP`) and share the single
 *     `tree-sitter-bash` grammar (like JavaScript's 4-extension single-grammar
 *     case, NOT TypeScript's two-grammar split).
 *   - `scopeSeparator: "."` — matching the codegraph `.sh` / `.bash` entries'
 *     explicit `"."`. Bash has no class concept — only top-level
 *     `function_definition`s — so the separator is never actually composed
 *     against a parent scope; it is carried for uniformity with the other
 *     verticals.
 *   - `scopeContainerTypes` — UNSET for Bash (mirrors `LANGUAGE_DEFINITIONS.bash`,
 *     which declares none — Bash has no class/method nesting to accumulate scope
 *     for).
 *   - `disambiguateOverloads` — UNSET for Bash (mirrors `LANGUAGE_DEFINITIONS.bash`;
 *     shell functions have no overloading).
 *   - `isInstanceMethod` — derived from `classifyMethod` (infra/symbolid) for
 *     uniformity with the other verticals. Bash has no methods, so this is moot:
 *     `function_definition` is a top-level function (never an instance method),
 *     and every node yields `classifyMethod(node) !== "instance"` → `false`,
 *     identical to the per-engine static checks.
 */

import type Parser from "tree-sitter";

import type { LanguageKernel } from "../../../contracts/types/language.js";
import { classifyMethod } from "../../../infra/symbolid/index.js";

interface TreeSitterLanguageModule {
  default?: unknown;
  [key: string]: unknown;
}

export const bashKernel: LanguageKernel = {
  loadModule: async () => import("tree-sitter-bash") as Promise<TreeSitterLanguageModule>,
  extractLanguage: (mod: TreeSitterLanguageModule) => mod.default ?? mod,
  scopeSeparator: ".",
  isInstanceMethod: (node: Parser.SyntaxNode) => classifyMethod(node) === "instance",
};
