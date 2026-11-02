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
 * Created per-context by `LanguageFactoryDescriptor` (each owns its own tree-sitter
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
 * RustCallResolver(mode)`, keeping the `LanguageFactoryDescriptor` signature unchanged.
 *
 * symbolId coverage convergence: the chunker emits the `Type#method` /
 * `Type.method` / `mod::Type` shapes via the generic chunker (engine
 * `tree-sitter.ts`, with the impl `nameExtractor`), while the codegraph emits
 * them via `walker.nameOf` (`rustNameOf`). Both route instance/associated-fn
 * classification through `classifyMethod` (via the kernel's
 * `methodKindFromClassify` / `isInstanceMethod`), so they stay in lockstep per
 * `.claude/rules/symbolid-convention.md`.
 */

import type { AstNode } from "../../../contracts/types/ast.js";
import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  emptyDispatchFanout,
  type AmbiguousResolveMode,
  type CallContext,
  type CallRef,
  type CallResolver,
  type DispatchFanoutOutcome,
  type FileExtraction,
  type SymbolResolutionPassPlan,
  type SymbolResolutionTarget,
} from "../../../contracts/types/codegraph.js";
import type {
  DeclaredTestFileSource,
  LanguageChunkerHooks,
  LanguageProvider,
  LanguageSymbolResolver,
  LanguageWalker,
  ManifestFilesReader,
  RustCallSiteSource,
  RustExternalSignatureSources,
} from "../../../contracts/types/language.js";
import { composeExtractionWalker } from "../kernel/index.js";
import { RustChunkClassifier } from "./chunking/classifier.js";
import { rustCommentCaptureHook } from "./chunking/comment-capture.js";
import { isRustModuleImport } from "./chunking/module-import.js";
import { rustTestDslFilterHook } from "./chunking/test-dsl-filter.js";
import { rustTestScopeChunkerHook } from "./chunking/test-scope-chunker.js";
import { RUST_DECLARED_TEST_FILES } from "./declared-test-files.js";
import { fileIsInlineTestOnly, isInlineTestNode } from "./inline-tests.js";
import { rustKernel } from "./kernel.js";
import { RustCallResolver } from "./resolver/index.js";
import { extractFromRustFile, RUST_EXTRACTION_PASSES, rustNameOf, type RustExtractInput } from "./walker/index.js";

/**
 * Chunk-boundary config for Rust — mirrors the chunker slice of the legacy
 * `LANGUAGE_DEFINITIONS.rust` entry 1:1 (chunkableTypes, childChunkTypes,
 * alwaysExtractChildren, nameExtractor). Rust's metadata hook captures comments
 * before methods and associated items; it does not claim containers. No
 * `macroSymbols` / `chunkSymbols` — Rust declares none (generic chunking).
 * `scopeContainerTypes`
 * + `scopeSeparator "::"` live on the KERNEL (not here) per the `LanguageKernel`
 * contract.
 *
 * `childChunkTypes` lists leaf chunks plus the containers whose own metadata
 * context must be traversed (functions, signatures, macros, impls, traits);
 * `mod_item` stays excluded so the descent traverses through modules to reach
 * methods, while `scopeContainerTypes`
 * (kernel) accumulates `impl Type` into the symbolId. The `nameExtractor` reads
 * the impl-block `type` field and strips generics + lifetimes so `impl<'s>
 * Worker<'s>` composes as `Worker#send`, not `Worker<'s>#send` (bd
 * tea-rags-mcp-h82m / 2hbd).
 */
const rustChunkerHooks: LanguageChunkerHooks = {
  chunkableTypes: [
    "function_item",
    "impl_item",
    "trait_item",
    "struct_item",
    "enum_item",
    "mod_item",
    "macro_definition",
    // Candidates only as a TEST-ONLY item (`#[cfg(test)] const LIMIT: usize = 3;`):
    // `rustTestDslFilterHook` rejects every other one, so discovery and the
    // module remainder treat production declarations exactly as before, and the
    // classifier gives the test-only one its `test_setup` chunk (bd
    // tea-rags-mcp-52wk3.9).
    "const_item",
    "static_item",
    "type_item",
    "union_item",
  ],
  // Keep impl blocks in the child-container walk so methods retain the
  // implementing header when they are nested below a module. The impl name
  // still composes through the kernel scope separator; it is not emitted as
  // an extra standalone leaf.
  childChunkTypes: ["function_item", "function_signature_item", "macro_definition", "impl_item", "trait_item"],
  alwaysExtractChildren: true,
  hooks: [rustTestDslFilterHook, rustCommentCaptureHook, rustTestScopeChunkerHook],
  // A top-level test-only item with no member to extract reaches no container
  // hook; the classifier gives it its `test` / `test_setup` chunk.
  classifier: new RustChunkClassifier(),
  // A file made test-only by an inner `#![cfg(test)]` has test-only top-level
  // code no chunk carries (a fixture under the chunk floor, `use super::*;`).
  moduleRemainderChunkType: (root, code) => (fileIsInlineTestOnly(root, code) ? "test_setup" : undefined),
  // An import's outer attribute rows and a body-less test-only `mod x;` stay
  // out of the module remainder with the import itself.
  isModuleImport: isRustModuleImport,
  // Rust function items are searchable symbols even when their bodies are
  // shorter than the generic 50-character noise floor.
  keepShortChildChunkTypes: ["function_item", "function_signature_item"],
  nameExtractor: (node: AstNode, code: string): string | undefined => {
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
  readonly walker: LanguageWalker = composeExtractionWalker({
    walk: (input) => extractFromRustFile(input),
    nameOf: (node) => rustNameOf(node),
    // Facet passes folded in after the monolith — see ./walker/passes.ts.
    passes: RUST_EXTRACTION_PASSES,
    // `#[cfg(test)]` items, `#[test]`-family fns and `#![cfg(test)]` files stay out of the graph.
    inlineTests: { isInlineTestNode, fileIsInlineTestOnly },
  });
  readonly resolver: LanguageSymbolResolver;
  /** `#[cfg(test)] mod x;` makes `x.rs` test code — a fact no path shape carries. */
  readonly declaredTestFiles: DeclaredTestFileSource = RUST_DECLARED_TEST_FILES;

  /**
   * `manifestFilesReader` reads the project's Cargo.toml files for the
   * workspace crate map (bd tea-rags-mcp-sjego); `signatureSources` locates
   * and caches the external signature table (bd s3i8m.7); `callSiteSource`
   * acquires the rustc call-site index (bd s3i8m T6). Injected by
   * `LanguageFactory` — this leaf never walks the disk itself.
   */
  constructor(
    mode: AmbiguousResolveMode = DEFAULT_AMBIGUOUS_RESOLVE_MODE,
    manifestFilesReader?: ManifestFilesReader,
    signatureSources?: RustExternalSignatureSources,
    callSiteSource?: RustCallSiteSource,
  ) {
    const callResolver: CallResolver = new RustCallResolver(
      mode,
      manifestFilesReader,
      signatureSources,
      callSiteSource,
    );
    this.resolver = {
      // Awaited before the pass-start seam: the rustc call-site index.
      warmResolvePass: async (plan: SymbolResolutionPassPlan): Promise<void> => callResolver.warmResolvePass?.(plan),
      // The pass-start seam re-reads the workspace's crate map and loads the
      // external signature table before the first crate-name path resolves.
      prepareResolvePass: (plan: SymbolResolutionPassPlan): void => callResolver.prepareResolvePass?.(plan),
      resolve: (call: CallRef, ctx: CallContext): SymbolResolutionTarget | null => callResolver.resolve(call, ctx),
      resolveDispatch: (call: CallRef, ctx: CallContext): DispatchFanoutOutcome =>
        callResolver.resolveDispatch?.(call, ctx) ?? emptyDispatchFanout(),
      targetsExternalImport: (call: CallRef, ctx: CallContext): boolean =>
        callResolver.targetsExternalImport?.(call, ctx) ?? false,
      hasInProjectDefinition: (call: CallRef, ctx: CallContext): boolean =>
        callResolver.hasInProjectDefinition?.(call, ctx) ?? false,
      targetsUndecidable: (call: CallRef, ctx: CallContext): boolean =>
        callResolver.targetsUndecidable?.(call, ctx) ?? false,
      diagnostics: (): Record<string, unknown> | undefined => callResolver.diagnostics?.(),
    };
  }
}

export { rustKernel } from "./kernel.js";
export { extractFromRustFile, rustNameOf } from "./walker/index.js";
export { RustCallResolver } from "./resolver/index.js";
export type { FileExtraction, RustExtractInput };
