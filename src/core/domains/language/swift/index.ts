/**
 * `SwiftLanguage` — the native per-language facade for Swift, composing the
 * four capability sub-modules:
 *
 *   kernel        ← ./kernel.ts       (parser load, scopeSeparator ".",
 *                                      scopeContainerTypes, disambiguateOverloads)
 *   chunkerHooks  ← (inline below)    (generic chunking — no hooks chain)
 *   walker        ← ./walker/         (extractFromSwiftFile + swiftNameOf)
 *   resolver      ← ./resolver/       (SwiftCallResolver — 6-pass chain)
 *
 * Tier 1 shipped grammar + chunking, so `find_symbol` resolves Swift outlines
 * and bodies and `hybrid_search`'s BM25 leg hits Swift tokens. Tier 2 adds the
 * call graph, which is why the ctor now takes an ambiguous-resolve `mode`:
 * there is finally a resolver to thread it into. Like python / java / rust (and
 * unlike go), `SwiftCallResolver`'s ctor takes ONLY `mode` — it needs no
 * `SymbolIdComposer`, building the `Type#member` / `Type.member` candidate ids
 * inline — so the `LanguageFactoryDescriptor` signature is unchanged.
 *
 * symbolId coverage convergence: the chunker emits `Type#method` /
 * `Type.method` / `Outer.Inner#method` / overload-`~N` via the generic chunker
 * engine, the codegraph emits them via `walker.nameOf` (`swiftNameOf`), and
 * both route instance/static classification through `classifyMethod` (the
 * kernel's `methodKindFromClassify` / `isInstanceMethod`) so they stay in
 * lockstep per `.claude/rules/symbolid-convention.md`.
 *
 * Chunking shape mirrors Java (methods + inits are leaf chunks, types are
 * scope containers) because tree-sitter-swift's shape maps onto it directly:
 *
 *   - `class_declaration` covers `class` / `struct` / `enum` / `extension` /
 *     `actor` (the keyword is an anonymous child; the `name` field is the type
 *     identifier in every shape). Container + scope container — nested types
 *     compose `Outer.Inner`, extension methods attribute to the extended type.
 *   - `function_declaration` is BOTH the top-level function and the method
 *     inside a type body. As a child chunk it composes `Type#method`
 *     (instance) or `Type.method` (`static` / `class` func) via
 *     `classifyMethod`; at the top level it composes the bare `name` form.
 *   - `init_declaration` composes `Type#init` — instance-bound per the
 *     convention, like the Java constructor. Its chunkType lands on "block"
 *     (the engine's `getChunkType` has no `init` family) — the same accepted
 *     state as a bash `command` chunk; the symbolId is what find_symbol reads.
 *   - `protocol_declaration` is a scope container so its
 *     `protocol_function_declaration` signatures compose `Proto#method`.
 *     Signatures are `keepShortChildChunkTypes` — they are routinely under the
 *     50-char child floor and the declaration IS the symbol (Java abstract
 *     methods, bd tea-rags-mcp-52e8).
 *
 * Deliberately NOT chunkable in tier 1: `property_declaration` (stored +
 * computed), `subscript_declaration` (its `name` field points at the RETURN
 * type, not a name), `deinit_declaration` (no name field), `typealias_declaration`,
 * `associatedtype_declaration`, `enum_entry`.
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
import { composeExtractionWalker } from "../kernel/extraction-passes.js";
import { swiftHooks } from "./chunking/index.js";
import { swiftKernel } from "./kernel.js";
import { SwiftCallResolver } from "./resolver/index.js";
import { swiftNameOf } from "./walker/name-of.js";
import { SWIFT_EXTRACTION_PASSES } from "./walker/passes.js";
import { extractFromSwiftFile, type SwiftExtractInput } from "./walker/walker.js";

/**
 * Chunk-boundary config for Swift — mirrors the chunker slice of
 * `LANGUAGE_DEFINITIONS.java` 1:1 (chunkableTypes / childChunkTypes /
 * alwaysExtractChildren, plus `keepShortChildChunkTypes` for signature-only
 * protocol requirements). No `hooks` / `nameExtractor` / `classifier` chain —
 * Swift needs none (generic chunking). `scopeContainerTypes` + `scopeSeparator`
 * + `disambiguateOverloads` live on the KERNEL per the `LanguageKernel`
 * contract.
 *
 * `childChunkTypes` lists ONLY the leaf chunks (funcs, inits, protocol
 * signatures); `class_declaration` / `protocol_declaration` are intentionally
 * excluded so the descent traverses THROUGH nested types to reach methods,
 * while `scopeContainerTypes` (kernel) accumulates `Outer.Inner` into the
 * symbolId.
 */
const swiftChunkerHooks: LanguageChunkerHooks = {
  chunkableTypes: [
    "function_declaration",
    "init_declaration",
    "class_declaration",
    "protocol_declaration",
    "protocol_function_declaration",
  ],
  childChunkTypes: ["function_declaration", "init_declaration", "protocol_function_declaration"],
  alwaysExtractChildren: true,
  keepShortChildChunkTypes: ["protocol_function_declaration", "init_declaration"],
  // Registering ANY hook flips two engine branches keyed on "does this language
  // have hooks at all": `chunkWithChildExtraction` stops emitting the narrow
  // parent type chunk (it switches to `ctx.bodyChunks`), and
  // `canRecurseAsContainer` starts recursing into every child. So the chain
  // carries a body chunker and a nested-function filter to hold both behaviours
  // in place — see `./chunking/index.ts`. `hook-chain-parity.test.ts` pins that
  // the chain changes nothing but `chunkType` and captured doc comments.
  hooks: swiftHooks,
};

/**
 * Native Swift `LanguageProvider`. Construction is cheap — the resolver is a
 * pure object (no codegraph / tsconfig deps, unlike TypeScript; no composer,
 * unlike Go) and the kernel is a shared module-level const — so the only
 * per-instance cost is the Parser the chunker / codegraph engines build.
 *
 * `hasInProjectDefinition` is forwarded EXPLICITLY. The resolution runner reads
 * the facade, never the `CallResolver` behind it, so a method the facade drops
 * silently reverts to the runner's default — the JavaScript `resolveFileEdges`
 * trap (bd tea-rags-mcp-x9qsh), where a unit test on the bare resolver passed
 * while production never called it.
 */
export class SwiftLanguage implements LanguageProvider {
  readonly kernel = swiftKernel;
  readonly chunkerHooks: LanguageChunkerHooks = swiftChunkerHooks;
  readonly walker: LanguageWalker = composeExtractionWalker({
    walk: (input) => extractFromSwiftFile(input),
    nameOf: (node) => swiftNameOf(node),
    // Empty today — see ./walker/passes.ts for why that is the design, not a gap.
    passes: SWIFT_EXTRACTION_PASSES,
  });
  readonly resolver: LanguageSymbolResolver;

  constructor(mode: AmbiguousResolveMode = DEFAULT_AMBIGUOUS_RESOLVE_MODE) {
    const callResolver: CallResolver = new SwiftCallResolver(mode);
    this.resolver = {
      resolve: (call: CallRef, ctx: CallContext): SymbolResolutionTarget | null => callResolver.resolve(call, ctx),
      resolveDispatch: (call: CallRef, ctx: CallContext): DispatchFanoutOutcome =>
        callResolver.resolveDispatch?.(call, ctx) ?? emptyDispatchFanout(),
      hasInProjectDefinition: (call: CallRef, ctx: CallContext): boolean =>
        callResolver.hasInProjectDefinition?.(call, ctx) ?? false,
    };
  }
}

export { swiftKernel } from "./kernel.js";
export { extractFromSwiftFile, swiftNameOf } from "./walker/index.js";
export { SwiftCallResolver } from "./resolver/index.js";
export type { FileExtraction, SwiftExtractInput };
