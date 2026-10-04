/**
 * TypeScript `LanguageKernel` — parser loading + the cross-engine detection +
 * namespace config shared by the TypeScript chunker and walker.
 *
 * Behaviour-preserving extraction of the fields the legacy adapter's
 * `kernelFrom(LANGUAGE_DEFINITIONS.typescript)` produced (spec §1, §3):
 *   - `loadModule` / `extractLanguage` — same lazy `tree-sitter-typescript`
 *     import; `extractLanguage` picks the `.typescript` grammar object out of
 *     the module (named export OR `default.typescript`) for every extension but
 *     `.tsx`, which selects the `.tsx` grammar. `LANGUAGE_MAP` collapses both
 *     extensions to language "typescript", so the extension is the only thing
 *     telling them apart: the chunker and the codegraph walk both pass the
 *     file's extension (bd tea-rags-mcp-e2pu7 moved that choice here from a
 *     static import in the codegraph extractor). A call with no extension gets
 *     the `typescript` grammar.
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
  loadModule: async () => import("tree-sitter-typescript"),
  grammarPackage: "tree-sitter-typescript",
  // The module ships two grammars. `.tsx` gets `tsx`; everything else — and a
  // call passing no extension — gets `typescript`.
  extractLanguage: (mod: TreeSitterLanguageModule, extension?: string) => {
    const grammar = extension === ".tsx" ? "tsx" : "typescript";
    if (typeof mod.default === "object" && mod.default !== null && grammar in mod.default) {
      return (mod.default as Record<string, unknown>)[grammar];
    }
    return mod[grammar];
  },
  scopeSeparator: ".",
  isInstanceMethod: (node: AstNode) => classifyMethod(node) === "instance",
};
