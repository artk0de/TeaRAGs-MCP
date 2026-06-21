/**
 * Rust `LanguageKernel` — parser loading + the cross-engine detection +
 * namespace config shared by the Rust chunker and walker.
 *
 * Behaviour-preserving extraction of the fields the legacy adapter's
 * `kernelFrom(LANGUAGE_DEFINITIONS.rust)` produced (spec §1, §3):
 *   - `loadModule` / `extractLanguage` — same lazy `tree-sitter-rust` import;
 *     `extractLanguage` is `mod.default ?? mod` (the Rust grammar is a plain
 *     default export). One grammar, one extension — `.rs` maps to language
 *     "rust" (`LANGUAGE_MAP`) and both engines share it.
 *   - `scopeSeparator: "::"` — Rust module/type namespacing
 *     (`mymod::Worker`), matching the codegraph `.rs` entry's explicit `"::"`.
 *     Methods STILL use `#`/`.` via `SymbolIdComposer` per
 *     `.claude/rules/symbolid-convention.md` — the `::` is namespace-only.
 *   - `scopeContainerTypes` — `impl_item` / `trait_item` / `mod_item`, so the
 *     chunker accumulates the full scope qualifier for impl-block leaf methods
 *     (`struct_item` / `enum_item` are NOT containers — they declare types but
 *     don't nest method chunks; methods live under `impl_item`). Mirrors
 *     `LANGUAGE_DEFINITIONS.rust` 1:1.
 *   - `disambiguateOverloads` — UNSET for Rust (mirrors
 *     `LANGUAGE_DEFINITIONS.rust`, which declares none — Rust has no method
 *     overloading; each `impl` method has a unique name in its scope).
 *   - `isInstanceMethod` — derived from `classifyMethod` (infra/symbolid): a
 *     `function_item` WITH a `self` / `&self` parameter is an instance method;
 *     one WITHOUT is an associated (static) function. Non-method nodes yield
 *     `null` → not "instance" → `false`, identical to the per-engine static
 *     checks (`infra/symbolid/classify.ts::rustHasSelfParam`).
 */

import type { AstNode } from "../../../contracts/types/ast.js";
import type { LanguageKernel } from "../../../contracts/types/language.js";
import { classifyMethod } from "../../../infra/symbolid/index.js";

interface TreeSitterLanguageModule {
  default?: unknown;
  [key: string]: unknown;
}

export const rustKernel: LanguageKernel = {
  loadModule: async () => import("tree-sitter-rust") as Promise<TreeSitterLanguageModule>,
  extractLanguage: (mod: TreeSitterLanguageModule) => mod.default ?? mod,
  scopeSeparator: "::",
  scopeContainerTypes: ["impl_item", "trait_item", "mod_item"],
  isInstanceMethod: (node: AstNode) => classifyMethod(node) === "instance",
};
