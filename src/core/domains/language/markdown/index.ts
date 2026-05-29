/**
 * `MarkdownLanguage` — the native per-language facade for Markdown, the NINTH and
 * FINAL vertical migrated off the composition-root legacy adapter into
 * `domains/language/` (spec §2, §4; bd tea-rags-mcp-cen6, following ruby +
 * typescript + javascript + python + go + java + rust + bash). With markdown,
 * EVERY language is native; the composition-root legacy adapter + chunker
 * registry that once wrapped per-language config into thunks were removed by
 * tea-rags-mcp-jh40, and the factory builds every provider itself.
 *
 * Markdown is DOC-ONLY (spec §1a, §1: "a doc language has only `chunkerHooks`,
 * no walker/resolver"). It exposes ONLY two of the four capability slots:
 *
 *   kernel        ← ./kernel.ts   (loadModule → null — NO grammar; remark parses
 *                                  markdown; isInstanceMethod via classifyMethod,
 *                                  moot — markdown never sees code AST nodes)
 *   chunkerHooks  ← (inline)      (chunkableTypes: [] + isDocumentation: true —
 *                                  the gate that routes markdown source to the
 *                                  remark-based `MarkdownChunker` engine in
 *                                  `tree-sitter.ts:chunk()`)
 *   walker        = undefined     (doc chunks use `doc:<hash>` ids — no codegraph
 *   resolver      = undefined      symbols, no call resolution)
 *
 * The `MarkdownChunker` ENGINE itself is NOT relocated here. It is a chunker
 * engine — a structural peer of `CharacterChunker` — that imports ingest's
 * `CharacterChunker` / `CodeChunker` and is constructed directly by
 * `TreeSitterChunker`. Both eslint leaf-domain guards forbid it living under
 * `domains/language` (which may not import `ingest`, and which `ingest` may not
 * import). So the engine stays in `domains/ingest/pipeline/chunker/markdown-chunker.ts`
 * (relocated there out of the old `hooks/markdown/` — it was never a
 * `ChunkingHook`). This vertical contributes only the per-language CONFIG slice
 * (kernel + chunkerHooks); behaviour is identical because the orchestrator still
 * gates on `chunkerHooks.isDocumentation` and invokes its own `markdownChunker`.
 *
 * Created per-context by `LanguageFactoryDescriptor` (each owns its own state, spec §5).
 * The capability config here is stateless module-level data — construction is
 * trivially cheap (no Parser: markdown has no grammar).
 */

import type {
  LanguageChunkerHooks,
  LanguageProvider,
  LanguageSymbolResolver,
  LanguageWalker,
} from "../../../contracts/types/language.js";
import { markdownKernel } from "./kernel.js";

/**
 * Chunk-boundary config for Markdown — mirrors the chunker slice of the legacy
 * `LANGUAGE_DEFINITIONS.markdown` entry 1:1: empty `chunkableTypes` (no
 * tree-sitter node types — markdown skips tree-sitter entirely) and
 * `isDocumentation: true` (the gate `tree-sitter.ts:chunk()` reads to route
 * markdown source to the remark-based `MarkdownChunker`).
 */
const markdownChunkerHooks: LanguageChunkerHooks = {
  chunkableTypes: [],
  isDocumentation: true,
};

/**
 * Native Markdown `LanguageProvider`. A DOC language: `chunkerHooks` only, with
 * `walker` and `resolver` left `undefined` (markdown has no codegraph symbols
 * and no call resolution). Construction is cheap — pure config, no Parser.
 */
export class MarkdownLanguage implements LanguageProvider {
  readonly kernel = markdownKernel;
  readonly chunkerHooks: LanguageChunkerHooks = markdownChunkerHooks;
  readonly walker: LanguageWalker | undefined = undefined;
  readonly resolver: LanguageSymbolResolver | undefined = undefined;
}

export { markdownKernel } from "./kernel.js";
