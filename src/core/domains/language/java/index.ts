/**
 * `JavaLanguage` — the native per-language facade for Java, the sixth vertical
 * migrated off the composition-root legacy adapter into `domains/language/`
 * (spec §2, §4; bd tea-rags-mcp-cen6, following ruby + typescript + javascript
 * + python + go). Thin: it composes the four capability sub-modules, all of
 * which are pure module-level logic + config that any instance merely
 * references.
 *
 *   kernel        ← ./kernel.ts            (parser load, scopeSeparator ".",
 *                                           scopeContainerTypes,
 *                                           disambiguateOverloads, detection)
 *   chunkerHooks  ← (inline below)         (generic chunking — NO language-specific
 *                                           hooks; Java's LANGUAGE_DEFINITIONS entry
 *                                           declares none)
 *   walker        ← ./walker/              (extractFromJavaFile + javaNameOf)
 *   resolver      ← ./resolver/            (JavaCallResolver — FQ-type import mapping)
 *
 * Created per-context by `LanguageFactoryDescriptor` (each owns its own tree-sitter
 * `Parser`, spec §5). The capability logic here is stateless, so the only
 * per-instance cost is the Parser the chunker/codegraph engines build.
 *
 * Unlike the JavaScript vertical, Java has NO `chunkSymbols` capability and NO
 * `hooks[]` chain — its `LANGUAGE_DEFINITIONS.java` entry uses the generic
 * chunker driven solely by node types (`chunkableTypes` / `childChunkTypes` /
 * `alwaysExtractChildren` / `keepShortChildChunkTypes`, with `scopeContainerTypes`
 * + `disambiguateOverloads` carried on the kernel). One grammar, one extension:
 * `.java` maps to language "java" (`LANGUAGE_MAP`) and both the chunker and
 * codegraph engines share the single `tree-sitter-java` grammar.
 *
 * Like python (and unlike go), `JavaCallResolver`'s ctor takes ONLY `mode` — it
 * needs no `SymbolIdComposer` (it builds the `Type#member` / `Type.member`
 * candidate ids inline). So `JavaLanguage` constructs it with `new
 * JavaCallResolver(mode)`, keeping the `LanguageFactoryDescriptor` signature unchanged.
 *
 * symbolId coverage convergence: the chunker emits the `Class#method` /
 * `Outer.Inner#method` / overload-`~N` shapes via the generic chunker (engine
 * `tree-sitter.ts`), while the codegraph emits them via `walker.nameOf`
 * (`javaNameOf`). Both route instance/static classification through
 * `classifyMethod` (via the kernel's `methodKindFromClassify`), so they stay in
 * lockstep per `.claude/rules/symbolid-convention.md`.
 */

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  type AmbiguousResolveMode,
  type CallContext,
  type CallRef,
  type CallResolver,
  type DispatchEdge,
  type FileExtraction,
  type SymbolResolutionTarget,
} from "../../../contracts/types/codegraph.js";
import type {
  LanguageChunkerHooks,
  LanguageProvider,
  LanguageSymbolResolver,
  LanguageWalker,
} from "../../../contracts/types/language.js";
import { javaKernel } from "./kernel.js";
import { JavaCallResolver } from "./resolver/index.js";
import { javaNameOf } from "./walker/name-of.js";
import { extractFromJavaFile, type JavaExtractInput } from "./walker/walker.js";

/**
 * Chunk-boundary config for Java — mirrors the chunker slice of the legacy
 * `LANGUAGE_DEFINITIONS.java` entry 1:1 (chunkableTypes, childChunkTypes,
 * alwaysExtractChildren, keepShortChildChunkTypes). No `hooks` / `nameExtractor`
 * / `macroSymbols` / `chunkSymbols` — Java declares none (generic chunking,
 * driven by node types alone). `scopeContainerTypes` + `disambiguateOverloads`
 * live on the KERNEL (not here) per the `LanguageKernel` contract.
 *
 * `childChunkTypes` lists ONLY the leaf chunks (methods + constructors); the
 * nested class/interface/enum types are intentionally excluded so the descent
 * traverses THROUGH nested class bodies to reach methods, while
 * `scopeContainerTypes` (kernel) accumulates `Outer.Inner` into the symbolId.
 * `keepShortChildChunkTypes: ["method_declaration"]` keeps signature-only
 * abstract / interface methods searchable (bd tea-rags-mcp-52e8).
 */
const javaChunkerHooks: LanguageChunkerHooks = {
  chunkableTypes: [
    "method_declaration",
    "constructor_declaration",
    "class_declaration",
    "interface_declaration",
    "enum_declaration",
    "annotation_type_declaration",
  ],
  childChunkTypes: ["method_declaration", "constructor_declaration"],
  alwaysExtractChildren: true,
  keepShortChildChunkTypes: ["method_declaration"],
};

/**
 * Native Java `LanguageProvider`. Construction is cheap — the resolver is a
 * pure object (no codegraph / tsconfig deps, unlike TypeScript; no composer,
 * unlike Go); the chunker worker simply never invokes it. `mode` controls
 * ambiguous-resolution behaviour, matching the legacy bootstrap wiring's
 * `JavaCallResolver` default.
 */
export class JavaLanguage implements LanguageProvider {
  readonly kernel = javaKernel;
  readonly chunkerHooks: LanguageChunkerHooks = javaChunkerHooks;
  readonly walker: LanguageWalker = {
    walk: (input) => extractFromJavaFile(input),
    nameOf: (node) => javaNameOf(node),
  };
  readonly resolver: LanguageSymbolResolver;

  constructor(mode: AmbiguousResolveMode = DEFAULT_AMBIGUOUS_RESOLVE_MODE) {
    const callResolver: CallResolver = new JavaCallResolver(mode);
    this.resolver = {
      resolve: (call: CallRef, ctx: CallContext): SymbolResolutionTarget | null => callResolver.resolve(call, ctx),
      resolveDispatch: (call: CallRef, ctx: CallContext): DispatchEdge[] =>
        callResolver.resolveDispatch?.(call, ctx) ?? [],
    };
  }
}

export { javaKernel } from "./kernel.js";
export { extractFromJavaFile, javaNameOf } from "./walker/index.js";
export { JavaCallResolver, mapJavaImportToFile } from "./resolver/index.js";
export type { FileExtraction, JavaExtractInput };
