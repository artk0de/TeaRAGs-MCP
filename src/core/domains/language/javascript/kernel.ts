/**
 * JavaScript `LanguageKernel` — parser loading + the cross-engine detection +
 * namespace config shared by the JavaScript chunker and walker.
 *
 * Behaviour-preserving extraction of the fields the legacy adapter's
 * `kernelFrom(LANGUAGE_DEFINITIONS.javascript)` produced (spec §1, §3):
 *   - `loadModule` / `extractLanguage` — same lazy `tree-sitter-javascript`
 *     import; `extractLanguage` is `mod.default ?? mod` (the JS grammar is a
 *     plain default export, unlike `tree-sitter-typescript`'s `{ typescript, tsx }`
 *     namespace). One grammar serves all four extensions (`.js`/`.jsx`/`.mjs`/
 *     `.cjs`) — `LANGUAGE_MAP` collapses them to language "javascript".
 *   - `scopeSeparator` — UNSET (defaults to `"."`), matching the
 *     `LANGUAGE_DEFINITIONS.javascript` value 1:1 (the codegraph `.js`/… entries
 *     set `"."` explicitly). Methods use `#`/`.` via `SymbolIdComposer`.
 *   - `scopeContainerTypes` / `disambiguateOverloads` — UNSET for JavaScript
 *     (mirrors `LANGUAGE_DEFINITIONS.javascript`, which declares neither).
 *   - `isInstanceMethod` — derived from `classifyMethod` (infra/symbolid): a
 *     `method_definition` without the `static` keyword is an instance method
 *     (JS shares the `method_definition` shape with TypeScript). Non-method
 *     nodes yield `null` → not "instance" → `false`, identical to the per-engine
 *     static checks.
 */

import type { AstNode } from "../../../contracts/types/ast.js";
import type { LanguageKernel } from "../../../contracts/types/language.js";
import { classifyMethod } from "../../../infra/symbolid/index.js";

interface TreeSitterLanguageModule {
  default?: unknown;
  [key: string]: unknown;
}

export const javascriptKernel: LanguageKernel = {
  loadModule: async () => import("tree-sitter-javascript") as Promise<TreeSitterLanguageModule>,
  extractLanguage: (mod: TreeSitterLanguageModule) => mod.default ?? mod,
  isInstanceMethod: (node: AstNode) => classifyMethod(node) === "instance",
};
