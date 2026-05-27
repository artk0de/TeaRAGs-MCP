/**
 * Java `LanguageKernel` — parser loading + the cross-engine detection +
 * namespace config shared by the Java chunker and walker.
 *
 * Behaviour-preserving extraction of the fields the legacy adapter's
 * `kernelFrom(LANGUAGE_DEFINITIONS.java)` produced (spec §1, §3):
 *   - `loadModule` / `extractLanguage` — same lazy `tree-sitter-java` import;
 *     `extractLanguage` is `mod.default ?? mod` (the Java grammar is a plain
 *     default export). One grammar, one extension — `.java` maps to language
 *     "java" (`LANGUAGE_MAP`) and both engines share it.
 *   - `scopeSeparator: "."` — Java nested-type join (`Outer.Inner#method`),
 *     matching the codegraph `.java` entry's explicit `"."` (also the default
 *     in `composeParentSymbol`, set explicitly here for clarity). Methods STILL
 *     use `#`/`.` via `SymbolIdComposer`.
 *   - `scopeContainerTypes` — `class_declaration` / `interface_declaration` /
 *     `enum_declaration` / `annotation_type_declaration`, so the chunker
 *     accumulates the full scope qualifier for nested-type leaf methods,
 *     matching `LANGUAGE_DEFINITIONS.java` 1:1.
 *   - `disambiguateOverloads: true` — Java methods can be overloaded; each
 *     overload carries a distinct body, so duplicate composed symbolIds inside
 *     one file are suffixed `~N` instead of deduped. Mirrors
 *     `LANGUAGE_DEFINITIONS.java` AND the codegraph `.java` entry (bd
 *     tea-rags-mcp-a466) so cg_symbols + Qdrant payload agree.
 *   - `isInstanceMethod` — derived from `classifyMethod` (infra/symbolid): a
 *     `method_declaration` without a `static` modifier is an instance method; a
 *     `static`-modified one is class-level. Non-method nodes yield `null` → not
 *     "instance" → `false`, identical to the per-engine static checks.
 */

import type Parser from "tree-sitter";

import type { LanguageKernel } from "../../../contracts/types/language.js";
import { classifyMethod } from "../../../infra/symbolid/index.js";

interface TreeSitterLanguageModule {
  default?: unknown;
  [key: string]: unknown;
}

export const javaKernel: LanguageKernel = {
  loadModule: async () => import("tree-sitter-java") as Promise<TreeSitterLanguageModule>,
  extractLanguage: (mod: TreeSitterLanguageModule) => mod.default ?? mod,
  scopeSeparator: ".",
  scopeContainerTypes: [
    "class_declaration",
    "interface_declaration",
    "enum_declaration",
    "annotation_type_declaration",
  ],
  disambiguateOverloads: true,
  isInstanceMethod: (node: Parser.SyntaxNode) => classifyMethod(node) === "instance",
};
