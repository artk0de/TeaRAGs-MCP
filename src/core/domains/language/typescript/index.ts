/**
 * `TypeScriptLanguage` — the native per-language facade for TypeScript, the
 * second vertical migrated off the composition-root legacy adapter into
 * `domains/language/` (spec §2, §4; bd tea-rags-mcp-cen6, following the ruby
 * pilot). Thin: it composes the four capability sub-modules, all of which are
 * pure module-level logic + config that any instance merely references.
 *
 *   kernel        ← ./kernel.ts            (parser load, scopeSeparator ".", detection)
 *   chunkerHooks  ← ./chunking/            (test-dsl filter/scope, comment-capture, class-body)
 *   walker        ← ./walker/              (extractFromTypescriptFile + tsNameOf)
 *   resolver      ← ./resolver/            (TSCallResolver — tsconfig path mapping)
 *
 * Created per-context by `LanguageFactoryDescriptor` (each owns its own tree-sitter
 * `Parser`, spec §5). The capability logic here is stateless, so the only
 * per-instance cost is the Parser the chunker/codegraph engines build, plus a
 * one-time `loadTsConfig(process.cwd())` for the resolver's path mapping.
 *
 * Two grammars, one provider: `.ts` and `.tsx` both map to language "typescript"
 * (`LANGUAGE_MAP`). The CHUNKER uses the kernel's `.typescript` grammar for both
 * (`kernel.ts` note). The CODEGRAPH engine loads the `.tsx` grammar for `.tsx`
 * files via the retained `CODEGRAPH_LANGUAGES[".tsx"].loadParser` — both reach
 * the SAME `walker.walk` (`extractFromTypescriptFile`, grammar-agnostic for the
 * node types it reads). So the provider parses both correctly without itself
 * holding two grammars: the per-extension grammar choice stays on the legacy map.
 */

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  emptyDispatchFanout,
  type AmbiguousResolveMode,
  type CallContext,
  type CallRef,
  type CallResolver,
  type DispatchFanoutOutcome,
  type FileExtraction,
  type SymbolResolutionTarget,
} from "../../../contracts/types/codegraph.js";
import type {
  LanguageChunkerHooks,
  LanguageProvider,
  LanguageSymbolResolver,
  LanguageWalker,
} from "../../../contracts/types/language.js";
import { typescriptChunkClassifier, typescriptHooks } from "./chunking/index.js";
import { typescriptKernel } from "./kernel.js";
import { loadTsConfig, TSCallResolver } from "./resolver/index.js";
import { tsNameOf } from "./walker/name-of.js";
import { extractFromTypescriptFile, type ExtractInput } from "./walker/walker.js";

/**
 * Chunk-boundary config for TypeScript — mirrors the chunker slice of the legacy
 * `LANGUAGE_DEFINITIONS.typescript` entry 1:1 (chunkableTypes, childChunkTypes,
 * alwaysExtractChildren, and the ordered hook chain). No `nameExtractor` /
 * `keepShortChildChunkTypes` / `macroSymbols` — TypeScript declares none (it has
 * no `def`-less method idiom, unlike Ruby's class-body DSL macros).
 */
const typescriptChunkerHooks: LanguageChunkerHooks = {
  chunkableTypes: [
    "function_declaration",
    "method_definition",
    "class_declaration",
    // tree-sitter-typescript emits `abstract_class_declaration` (NOT
    // `class_declaration`) for `abstract class X {}` — bd tea-rags-mcp-olc2.
    // Without it the abstract container is never recognized, so its methods
    // never become standalone chunks and `find_symbol("Base#foo")` misses
    // the body even though the codegraph layer has the symbol. The codegraph
    // provider already treats both node types alike (symbols/provider.ts).
    "abstract_class_declaration",
    "interface_declaration",
    "type_alias_declaration",
    "enum_declaration",
    "call_expression", // Filtered by testDslFilterHook to DSL calls in test files
    // bd tea-rags-mcp-grz07 — kept ONLY when the declaration binds a
    // MODULE-LEVEL function expression (`export const fn = () => {}`), the
    // dominant declaration shape in React code, which produced no chunk at all
    // before. `typescriptFunctionDeclarationFilterHook` rejects every other
    // declaration so `findChunkableNodes` keeps DESCENDING through it — which is
    // what the const-object namespace (`export const X = { m() {} }`) needs to
    // reach its `method_definition` (bd tea-rags-mcp-62hzr). The symbolId is
    // then composed by `typescriptChunkClassifier`, since a
    // `lexical_declaration` carries no `name` field of its own.
    //
    // Mirrors JavaScript, which has listed both since bd tea-rags-mcp-kfzx.
    "lexical_declaration",
    "variable_declaration",
  ],
  childChunkTypes: ["method_definition", "call_expression"],
  alwaysExtractChildren: true,
  hooks: typescriptHooks,
  classifier: typescriptChunkClassifier,
};

/**
 * Native TypeScript `LanguageProvider`. Construction is cheap — the resolver
 * loads the tsconfig from `process.cwd()` once (mirroring the legacy
 * bootstrap wiring `new TSCallResolver(loadTsConfig(process.cwd()), mode)`); the
 * chunker worker simply never invokes the resolver. `mode` controls
 * ambiguous-resolution behaviour, matching the legacy adapter's `TSCallResolver`
 * default.
 */
export class TypeScriptLanguage implements LanguageProvider {
  readonly kernel = typescriptKernel;
  readonly chunkerHooks: LanguageChunkerHooks = typescriptChunkerHooks;
  readonly walker: LanguageWalker = {
    walk: (input) => extractFromTypescriptFile(input),
    nameOf: (node) => tsNameOf(node),
  };
  readonly resolver: LanguageSymbolResolver;

  constructor(mode: AmbiguousResolveMode = DEFAULT_AMBIGUOUS_RESOLVE_MODE) {
    // One root for both concerns: the tsconfig the path mapper reads and the
    // project the typeChecker fallback resolves files against must be the same
    // directory, or a Program would be built from paths the mapper never
    // produces (bd tea-rags-mcp-uclbn).
    const repoRoot = process.cwd();
    const callResolver: CallResolver = new TSCallResolver(loadTsConfig(repoRoot), mode, repoRoot);
    this.resolver = {
      resolve: (call: CallRef, ctx: CallContext): SymbolResolutionTarget | null => callResolver.resolve(call, ctx),
      resolveDispatch: (call: CallRef, ctx: CallContext): DispatchFanoutOutcome =>
        callResolver.resolveDispatch?.(call, ctx) ?? emptyDispatchFanout(),
      // Forwarded so imports map through `mapImportToFile` rather than through
      // the provider's synthesised-call loop, whose fake `member` a member-keyed
      // pass can answer (bd tea-rags-mcp-5onmn). Mirrors the Ruby adapter.
      resolveFileEdges: (extraction, ctx) => callResolver.resolveFileEdges?.(extraction, ctx) ?? [],
      targetsExternalImport: (call: CallRef, ctx: CallContext): boolean =>
        callResolver.targetsExternalImport?.(call, ctx) ?? false,
    };
  }
}

export { typescriptKernel } from "./kernel.js";
export { typescriptHooks } from "./chunking/index.js";
export { extractFromTypescriptFile, tsNameOf } from "./walker/index.js";
export {
  createProjectFileProbe,
  loadTsConfig,
  mapImportToFile,
  TSCallResolver,
  type ProjectFileProbe,
  type TsCompilerOptions,
} from "./resolver/index.js";
export type { FileExtraction, ExtractInput };
