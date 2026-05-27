/**
 * `GoLanguage` — the native per-language facade for Go, the fifth vertical
 * migrated off the composition-root legacy adapter into `domains/language/`
 * (spec §2, §4; bd tea-rags-mcp-cen6, following ruby + typescript + javascript
 * + python). Thin: it composes the four capability sub-modules, all of which
 * are pure module-level logic + config that any instance merely references.
 *
 *   kernel        ← ./kernel.ts            (parser load, scopeSeparator ".", detection)
 *   chunkerHooks  ← (inline below)         (generic chunking — NO language-specific
 *                                           hooks; Go's LANGUAGE_DEFINITIONS entry
 *                                           declares none)
 *   walker        ← ./walker/              (extractFromGoFile + goNameOf)
 *   resolver      ← ./resolver/            (GoCallResolver — package-path mapping)
 *
 * Created per-context by `LanguageFactory` (each owns its own tree-sitter
 * `Parser`, spec §5). The capability logic here is stateless, so the only
 * per-instance cost is the Parser the chunker/codegraph engines build.
 *
 * Unlike the JavaScript vertical, Go has NO `chunkSymbols` capability and NO
 * `hooks[]` chain — its `LANGUAGE_DEFINITIONS.go` entry uses the generic
 * chunker driven solely by `chunkableTypes`. One grammar, one extension: `.go`
 * maps to language "go" (`LANGUAGE_MAP`) and both the chunker and codegraph
 * engines share the single `tree-sitter-go` grammar.
 *
 * SymbolId composer: unlike ruby/ts/js/python, `GoCallResolver` needs a
 * `SymbolIdComposer` to build the `Type#member` / `Type.member` candidate ids
 * for typed-receiver resolution. `GoLanguage` self-constructs the stateless
 * `DefaultSymbolIdComposer` (a pure mapper in the same `domains/language`
 * domain) and passes it to the resolver — keeping the `LanguageFactory`
 * signature unchanged (no composer threading through the factory).
 *
 * symbolId coverage convergence: the chunker emits the `Receiver#Method` /
 * top-level shapes via the generic chunker (engine `tree-sitter.ts`'s
 * `extractGoSymbol`), while the codegraph emits them via `walker.nameOf`
 * (`goNameOf`). Both stay in lockstep per
 * `.claude/rules/symbolid-convention.md`.
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
import { DefaultSymbolIdComposer } from "../kernel/symbol-id.js";
import { goKernel } from "./kernel.js";
import { GoCallResolver } from "./resolver/index.js";
import { goNameOf } from "./walker/name-of.js";
import { extractFromGoFile, type GoExtractInput } from "./walker/walker.js";

/**
 * Chunk-boundary config for Go — mirrors the chunker slice of the legacy
 * `LANGUAGE_DEFINITIONS.go` entry 1:1 (chunkableTypes only). No `hooks` /
 * `nameExtractor` / `childChunkTypes` / `alwaysExtractChildren` /
 * `scopeContainerTypes` / `macroSymbols` / `chunkSymbols` — Go declares none
 * (generic chunking, driven by node types alone). Go has no nested classes,
 * so each `function_declaration` / `method_declaration` / `type_declaration` /
 * `interface_declaration` is a top-level chunk.
 */
const goChunkerHooks: LanguageChunkerHooks = {
  chunkableTypes: ["function_declaration", "method_declaration", "type_declaration", "interface_declaration"],
};

/**
 * Native Go `LanguageProvider`. Construction is cheap — the resolver is a pure
 * object (it owns a stateless `DefaultSymbolIdComposer`, no codegraph /
 * tsconfig deps); the chunker worker simply never invokes it. `mode` controls
 * ambiguous-resolution behaviour, matching the legacy bootstrap wiring's
 * `GoCallResolver` default.
 */
export class GoLanguage implements LanguageProvider {
  readonly kernel = goKernel;
  readonly chunkerHooks: LanguageChunkerHooks = goChunkerHooks;
  readonly walker: LanguageWalker = {
    walk: (input) => extractFromGoFile(input),
    nameOf: (node) => goNameOf(node),
  };
  readonly resolver: LanguageSymbolResolver;

  constructor(mode: AmbiguousResolveMode = DEFAULT_AMBIGUOUS_RESOLVE_MODE) {
    const callResolver: CallResolver = new GoCallResolver(new DefaultSymbolIdComposer(), mode);
    this.resolver = {
      resolve: (call: CallRef, ctx: CallContext): ResolvedTarget | null => callResolver.resolve(call, ctx),
      resolveDispatch: (call: CallRef, ctx: CallContext): DispatchEdge[] =>
        callResolver.resolveDispatch?.(call, ctx) ?? [],
    };
  }
}

export { goKernel } from "./kernel.js";
export { extractFromGoFile, goNameOf } from "./walker/index.js";
export { GoCallResolver } from "./resolver/index.js";
export type { FileExtraction, GoExtractInput };
