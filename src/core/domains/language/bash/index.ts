/**
 * `BashLanguage` — the native per-language facade for Bash, the eighth and LAST
 * SOURCE-language vertical migrated off the composition-root legacy adapter into
 * `domains/language/` (spec §2, §4; bd tea-rags-mcp-cen6, following ruby +
 * typescript + javascript + python + go + java + rust). After Bash, only
 * markdown remains adapter-served — and markdown is doc-only (chunker-only, no
 * walker / resolver), so every SOURCE language is now native. Thin: it composes
 * the four capability sub-modules, all of which are pure module-level logic +
 * config that any instance merely references.
 *
 *   kernel        ← ./kernel.ts            (parser load, scopeSeparator ".",
 *                                           detection)
 *   chunkerHooks  ← (inline below)         (generic chunking — NO hooks chain,
 *                                           NO nameExtractor; Bash's
 *                                           LANGUAGE_DEFINITIONS entry declares
 *                                           only chunkableTypes)
 *   walker        ← ./walker/              (extractFromBashFile + bashNameOf)
 *   resolver      ← ./resolver/            (BashCallResolver — `source` path
 *                                           mapping + global short-name lookup)
 *
 * Created per-context by `LanguageFactoryDescriptor` (each owns its own tree-sitter
 * `Parser`, spec §5). The capability logic here is stateless, so the only
 * per-instance cost is the Parser the chunker/codegraph engines build.
 *
 * Two extensions, ONE grammar: `.sh` AND `.bash` both map to language "bash"
 * (`LANGUAGE_MAP`) and share the single `tree-sitter-bash` grammar — like
 * JavaScript's 4-extension single-grammar case, NOT TypeScript's two-grammar
 * split. The codegraph `.sh` / `.bash` entries each retain `loadParser` +
 * `scopeSeparator "."` (same `BashLang` grammar); the walker / nameOf / resolver
 * come from THIS provider via the injected `LanguageFactoryDescriptor`.
 *
 * Bash has NO class concept — only top-level `function_definition`s — so there
 * are NO `scopeContainerTypes`, NO `disambiguateOverloads`, and `bashNameOf`
 * emits a leaf symbol with no `methodKind`. `isInstanceMethod` is wired via
 * `classifyMethod` on the kernel for uniformity with the other verticals, but it
 * is moot (a `function_definition` is never an instance method).
 *
 * Like python + java + rust (and unlike go), `BashCallResolver`'s ctor takes
 * ONLY `mode` — it needs no `SymbolIdComposer` (bash has no `Type#member` /
 * `Type.member` candidate ids to build). So `BashLanguage` constructs it with
 * `new BashCallResolver(mode)`, keeping the `LanguageFactoryDescriptor` signature
 * unchanged.
 */

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  type AmbiguousResolveMode,
  type CallContext,
  type CallRef,
  type CallResolver,
  type DispatchEdge,
  type FileExtraction,
  type ResolvedTarget,
} from "../../../contracts/types/codegraph.js";
import type {
  LanguageChunkerHooks,
  LanguageProvider,
  LanguageSymbolResolver,
  LanguageWalker,
} from "../../../contracts/types/language.js";
import { bashKernel } from "./kernel.js";
import { BashCallResolver } from "./resolver/index.js";
import { bashNameOf } from "./walker/name-of.js";
import { extractFromBashFile, type BashExtractInput } from "./walker/walker.js";

/**
 * Chunk-boundary config for Bash — mirrors the chunker slice of the legacy
 * `LANGUAGE_DEFINITIONS.bash` entry 1:1 (chunkableTypes only). No `hooks` /
 * `nameExtractor` / `childChunkTypes` / `alwaysExtractChildren` /
 * `scopeContainerTypes` / `macroSymbols` / `chunkSymbols` — Bash declares none
 * (generic chunking, driven by node types alone). Each top-level
 * `function_definition` is a chunk; `command` is chunkable so script bodies that
 * are bare command sequences (no function wrapper) are not dropped.
 */
const bashChunkerHooks: LanguageChunkerHooks = {
  chunkableTypes: ["function_definition", "command"],
};

/**
 * Native Bash `LanguageProvider`. Construction is cheap — the resolver is a pure
 * object (no codegraph / tsconfig deps, unlike TypeScript; no composer, unlike
 * Go); the chunker worker simply never invokes it. `mode` controls
 * ambiguous-resolution behaviour, matching the legacy bootstrap wiring's
 * `BashCallResolver` default.
 */
export class BashLanguage implements LanguageProvider {
  readonly kernel = bashKernel;
  readonly chunkerHooks: LanguageChunkerHooks = bashChunkerHooks;
  readonly walker: LanguageWalker = {
    walk: (input) => extractFromBashFile(input),
    nameOf: (node) => bashNameOf(node),
  };
  readonly resolver: LanguageSymbolResolver;

  constructor(mode: AmbiguousResolveMode = DEFAULT_AMBIGUOUS_RESOLVE_MODE) {
    const callResolver: CallResolver = new BashCallResolver(mode);
    this.resolver = {
      resolve: (call: CallRef, ctx: CallContext): ResolvedTarget | null => callResolver.resolve(call, ctx),
      resolveDispatch: (call: CallRef, ctx: CallContext): DispatchEdge[] =>
        callResolver.resolveDispatch?.(call, ctx) ?? [],
    };
  }
}

export { bashKernel } from "./kernel.js";
export { extractFromBashFile, bashNameOf } from "./walker/index.js";
export { BashCallResolver, mapBashSourceToFile } from "./resolver/index.js";
export type { FileExtraction, BashExtractInput };
