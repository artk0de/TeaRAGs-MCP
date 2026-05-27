/**
 * `RustLanguage` — the native per-language facade for Rust, the seventh vertical
 * migrated off the composition-root legacy adapter into `domains/language/`
 * (spec §2, §4; bd tea-rags-mcp-cen6, following ruby + typescript + javascript
 * + python + go + java). Thin: it composes the four capability sub-modules, all
 * of which are pure module-level logic + config that any instance merely
 * references.
 *
 *   kernel        ← ./kernel.ts            (parser load, scopeSeparator "::",
 *                                           scopeContainerTypes, detection)
 *   chunkerHooks  ← (inline below)         (generic chunking — NO hooks chain;
 *                                           carries the impl-name `nameExtractor`
 *                                           Rust's LANGUAGE_DEFINITIONS declares)
 *   walker        ← ./walker/              (extractFromRustFile + rustNameOf)
 *   resolver      ← ./resolver/            (RustCallResolver — `use`-path mapping)
 *
 * Created per-context by `LanguageFactory` (each owns its own tree-sitter
 * `Parser`, spec §5). The capability logic here is stateless, so the only
 * per-instance cost is the Parser the chunker/codegraph engines build.
 *
 * Unlike the JavaScript vertical, Rust has NO `chunkSymbols` capability and NO
 * `hooks[]` chain — its `LANGUAGE_DEFINITIONS.rust` entry uses the generic
 * chunker driven by node types PLUS a `nameExtractor` for impl-block scope names
 * (`impl<'s> Worker<'s>` → "Worker"). `scopeContainerTypes` (impl/trait/mod) and
 * `scopeSeparator "::"` live on the KERNEL. One grammar, one extension: `.rs`
 * maps to language "rust" (`LANGUAGE_MAP`) and both the chunker and codegraph
 * engines share the single `tree-sitter-rust` grammar.
 *
 * Like python + java (and unlike go), `RustCallResolver`'s ctor takes ONLY
 * `mode` — it needs no `SymbolIdComposer` (it builds the `Type#member` /
 * `Type.member` candidate ids inline). So `RustLanguage` constructs it with `new
 * RustCallResolver(mode)`, keeping the `LanguageFactory` signature unchanged.
 *
 * symbolId coverage convergence: the chunker emits the `Type#method` /
 * `Type.method` / `mod::Type` shapes via the generic chunker (engine
 * `tree-sitter.ts`, with the impl `nameExtractor`), while the codegraph emits
 * them via `walker.nameOf` (`rustNameOf`). Both route instance/associated-fn
 * classification through `classifyMethod` (via the kernel's
 * `methodKindFromClassify` / `isInstanceMethod`), so they stay in lockstep per
 * `.claude/rules/symbolid-convention.md`.
 */

import type Parser from "tree-sitter";

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
import { rustKernel } from "./kernel.js";
import { RustCallResolver } from "./resolver/index.js";
import { rustNameOf } from "./walker/name-of.js";
import { extractFromRustFile, type RustExtractInput } from "./walker/walker.js";

/**
 * Chunk-boundary config for Rust — mirrors the chunker slice of the legacy
 * `LANGUAGE_DEFINITIONS.rust` entry 1:1 (chunkableTypes, childChunkTypes,
 * alwaysExtractChildren, nameExtractor). No `hooks` / `macroSymbols` /
 * `chunkSymbols` — Rust declares none (generic chunking). `scopeContainerTypes`
 * + `scopeSeparator "::"` live on the KERNEL (not here) per the `LanguageKernel`
 * contract.
 *
 * `childChunkTypes` lists ONLY the leaf chunks (functions + macro defs);
 * `impl_item` / `trait_item` / `mod_item` are intentionally excluded so the
 * descent traverses THROUGH them to reach methods, while `scopeContainerTypes`
 * (kernel) accumulates `impl Type` into the symbolId. The `nameExtractor` reads
 * the impl-block `type` field and strips generics + lifetimes so `impl<'s>
 * Worker<'s>` composes as `Worker#send`, not `Worker<'s>#send` (bd
 * tea-rags-mcp-h82m / 2hbd).
 */
const rustChunkerHooks: LanguageChunkerHooks = {
  chunkableTypes: ["function_item", "impl_item", "trait_item", "struct_item", "enum_item", "mod_item", "macro_definition"],
  childChunkTypes: ["function_item", "macro_definition"],
  alwaysExtractChildren: true,
  nameExtractor: (node: Parser.SyntaxNode, code: string): string | undefined => {
    if (node.type !== "impl_item") return undefined;
    const ty = node.childForFieldName("type");
    if (!ty) return undefined;
    const raw = code.substring(ty.startIndex, ty.endIndex);
    // Strip generic params + lifetimes: `Worker<'s>` → `Worker`,
    // `Container<T: Clone>` → `Container`. The bare type identifier
    // is the part before the first `<`.
    const lt = raw.indexOf("<");
    return (lt === -1 ? raw : raw.slice(0, lt)).trim();
  },
};

/**
 * Native Rust `LanguageProvider`. Construction is cheap — the resolver is a
 * pure object (no codegraph / tsconfig deps, unlike TypeScript; no composer,
 * unlike Go); the chunker worker simply never invokes it. `mode` controls
 * ambiguous-resolution behaviour, matching the legacy bootstrap wiring's
 * `RustCallResolver` default.
 */
export class RustLanguage implements LanguageProvider {
  readonly kernel = rustKernel;
  readonly chunkerHooks: LanguageChunkerHooks = rustChunkerHooks;
  readonly walker: LanguageWalker = {
    walk: (input) => extractFromRustFile(input),
    nameOf: (node) => rustNameOf(node),
  };
  readonly resolver: LanguageSymbolResolver;

  constructor(mode: AmbiguousResolveMode = DEFAULT_AMBIGUOUS_RESOLVE_MODE) {
    const callResolver: CallResolver = new RustCallResolver(mode);
    this.resolver = {
      resolve: (call: CallRef, ctx: CallContext): ResolvedTarget | null => callResolver.resolve(call, ctx),
      resolveDispatch: (call: CallRef, ctx: CallContext): DispatchEdge[] =>
        callResolver.resolveDispatch?.(call, ctx) ?? [],
    };
  }
}

export { rustKernel } from "./kernel.js";
export { extractFromRustFile, rustNameOf } from "./walker/index.js";
export { RustCallResolver } from "./resolver/index.js";
export type { FileExtraction, RustExtractInput };
