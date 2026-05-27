/**
 * Markdown `LanguageKernel` — the parser-load + detection slice of the doc-only
 * markdown vertical. Markdown is the FINAL language migrated off the
 * composition-root legacy adapter (spec §2, §4; bd tea-rags-mcp-cen6, following
 * ruby + typescript + javascript + python + go + java + rust + bash). After it,
 * every language is native and the legacy adapter is vestigial (removed by
 * tea-rags-mcp-jh40).
 *
 * Behaviour-preserving extraction of the fields the legacy adapter's
 * `kernelFrom(LANGUAGE_DEFINITIONS.markdown)` produced (spec §1, §3). Markdown is
 * a DOC language: it has NO tree-sitter grammar, NO walker, NO resolver. Its
 * source is chunked by the remark-based `MarkdownChunker` engine (an ingest
 * concern — the chunker engine, peer of `CharacterChunker`), which the chunker
 * orchestrator routes to when `chunkerHooks.isDocumentation` is set:
 *
 *   - `loadModule` — resolves to `null` (NO grammar). The original entry's NOTE
 *     records that tree-sitter-markdown is unused due to a compat issue (needs
 *     tree-sitter 0.26+); remark (unified/mdast) parses markdown instead. The
 *     chunker engine never reaches `initializeParser` for markdown — the
 *     `isDocumentation` gate in `tree-sitter.ts:chunk()` short-circuits to the
 *     `MarkdownChunker` before any grammar load. `loadModule: () => null` mirrors
 *     the original `Promise.resolve(null)` exactly.
 *   - NO `extractLanguage` / `scopeSeparator` / `scopeContainerTypes` /
 *     `disambiguateOverloads` — markdown declares none (the original entry set
 *     none either; doc chunks use `doc:<hash>` ids with no scope composition).
 *   - `isInstanceMethod` — derived from `classifyMethod` (infra/symbolid) for
 *     uniformity with the source-language verticals. Moot for markdown: it never
 *     sees code AST nodes (no walker, no parser), and every node yields
 *     `classifyMethod(node) !== "instance"` → `false`, identical to the legacy
 *     adapter's `kernelFrom` derivation.
 */

import type Parser from "tree-sitter";

import type { LanguageKernel } from "../../../contracts/types/language.js";
import { classifyMethod } from "../../../infra/symbolid/index.js";

export const markdownKernel: LanguageKernel = {
  // No tree-sitter grammar — remark parses markdown. Mirrors the legacy
  // `LANGUAGE_DEFINITIONS.markdown` entry's `loadModule: () => Promise.resolve(null)`.
  loadModule: async () => Promise.resolve(null),
  isInstanceMethod: (node: Parser.SyntaxNode) => classifyMethod(node) === "instance",
};
