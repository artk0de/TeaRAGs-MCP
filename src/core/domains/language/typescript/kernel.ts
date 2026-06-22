/**
 * TypeScript `LanguageKernel` — parser loading + the cross-engine detection +
 * namespace config shared by the TypeScript chunker and walker.
 *
 * Behaviour-preserving extraction of the fields the legacy adapter's
 * `kernelFrom(LANGUAGE_DEFINITIONS.typescript)` produced (spec §1, §3):
 *   - `loadModule` / `extractLanguage` — same lazy `tree-sitter-typescript`
 *     import; `extractLanguage` picks the `.typescript` grammar object out of
 *     the module (named export OR `default.typescript`). This is the grammar the
 *     CHUNKER uses for BOTH `.ts` and `.tsx` files (`LANGUAGE_MAP` collapses
 *     both extensions to language "typescript", and `LANGUAGE_DEFINITIONS` is
 *     keyed by name → one config). The codegraph engine, by contrast, loads the
 *     `.tsx` grammar for `.tsx` files via `CODEGRAPH_LANGUAGES[".tsx"].loadParser`
 *     (retained in the legacy map) — see the provider note. So the two-grammar
 *     distinction lives where it always did: chunker → `.typescript` grammar
 *     (this kernel), codegraph → per-extension `loadParser` on the retained map.
 *   - `scopeSeparator: "."` — TS/JS namespace join (`namespace A { class B }`
 *     → `A.B`). Methods use `#`/`.` via `SymbolIdComposer`. `.` is also the
 *     composer default, so this matches the unset `LANGUAGE_DEFINITIONS.typescript`
 *     value 1:1 (the codegraph `.ts`/`.tsx` entries set it explicitly too).
 *   - `scopeContainerTypes` / `disambiguateOverloads` — UNSET for TypeScript
 *     (mirrors `LANGUAGE_DEFINITIONS.typescript`, which declares neither; TS
 *     getter/setter accessor pairs deliberately let the first occurrence win,
 *     unlike Java overloads — see the provider's `disambiguateOverloads` note).
 *   - `isInstanceMethod` — derived from `classifyMethod` (infra/symbolid): a
 *     `method_definition` without the `static` keyword is an instance method.
 *     Non-method nodes yield `null` → not "instance" → `false`, identical to
 *     the per-engine static checks.
 */

import type { AstNode } from "../../../contracts/types/ast.js";
import type { LanguageKernel } from "../../../contracts/types/language.js";
import { classifyMethod } from "../../../infra/symbolid/index.js";

interface TreeSitterLanguageModule {
  default?: unknown;
  typescript?: unknown;
  [key: string]: unknown;
}

export const typescriptKernel: LanguageKernel = {
  loadModule: async () => import("tree-sitter-typescript") as Promise<TreeSitterLanguageModule>,
  extractLanguage: (mod: TreeSitterLanguageModule) => {
    if (typeof mod.default === "object" && mod.default !== null && "typescript" in mod.default) {
      return (mod.default as Record<string, unknown>).typescript;
    }
    return mod.typescript;
  },
  scopeSeparator: ".",
  isInstanceMethod: (node: AstNode) => classifyMethod(node) === "instance",
};
