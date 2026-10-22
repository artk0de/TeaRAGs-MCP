/**
 * Rust implementation of the `CallResolver` contract. Relocated from
 * `domains/trajectory/codegraph/symbols/resolvers/rust/rust-resolver.ts` into
 * the native Rust language provider per the `domains/language` consolidation
 * (spec §3; bd tea-rags-mcp-cen6). Behaviour-preserving.
 *
 * `resolve` runs an ordered chain of single-purpose `SymbolResolutionStrategy`
 * passes (see `./strategies/`) via the shared `resolveViaChain` engine. The
 * array order encodes precedence, and the four-state outcome
 * (resolved / deferred / drop / continue) makes the load-bearing guard drops explicit —
 * e.g. a `self.<field>` receiver whose field type is unknown DROPS rather than
 * falling through to the import-match / global short-name paths that would
 * route to an unrelated type's member (bd tea-rags-mcp-q1pl).
 *
 * Rust paths use `::` separators with prefixes:
 *   - `crate::` — current crate root
 *   - `super::` — parent module
 *   - `self::` — current module
 *   - bare paths — refer to a use'd import or external crate
 *
 * Without project-level Cargo metadata we resolve by basename match
 * over the symbol table — for `use crate::foo::bar`, look up `bar`
 * and accept any file whose path ends in `foo/bar.rs` (or
 * `foo/bar/mod.rs`). External crates are out of scope.
 *
 * The pass order (each `name` in parens):
 *   0. macroInvocation (`name!` / `path::name!` — owns every macro invocation
 *      and answers it from macro definitions only; terminal, so no fn pass
 *      ever sees one — bd tea-rags-mcp-s3i8m.2)
 *   1. selfMethod (self.X same-file — intra-impl call)
 *   2. selfField (self.field.X via declared field type — terminal guard)
 *   3. localBinding (obj.X via walker-bound type — terminal guard on miss)
 *   4. typeReceiver (Type::X / Self::X / Type::new().X via an in-project
 *      type — terminal guard on miss). After localBinding because a local
 *      binding is the more specific evidence for a bare identifier; before
 *      importMatch and globalShortName because both would otherwise answer a
 *      type-path call by member name alone (bd tea-rags-mcp-7266).
 *   5. importMatch (receiver ∈ use import → suffix basename match)
 *   6. bareSelfMethod (bare X() inside impl → enclosing-type probe)
 *   7. globalShortName (global short-name fallback)
 *   8. traitSelfMethod (trait-provided `self.m()`)
 *   9. rustAnalyzerScip (the rust-analyzer SCIP index's definition for the
 *      member token, mapped onto a table symbol — the residual only)
 */

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  type AmbiguousResolveMode,
  type CallContext,
  type CallRef,
  type CallResolver,
  type SymbolResolutionPassPlan,
  type SymbolResolutionTarget,
} from "../../../../contracts/types/codegraph.js";
import type {
  DispatchResolverComponent,
  ManifestFilesReader,
  RustAnalyzerScipSource,
  RustExternalSignatureSources,
  SymbolResolutionStrategy,
} from "../../../../contracts/types/language.js";
import { ConeDispatchResolver, resolveDispatchViaComponents, resolveViaChain } from "../../kernel/index.js";
import { RustExternalVocabulary } from "../vocabulary/external-call.js";
import { RustResolveEnvironmentCache } from "./resolve-environment-cache.js";
import { withRustResolveEnvironment } from "./resolve-environment.js";
import { RustConeTypeLocator } from "./rust-cone-type-locator.js";
import { rustScipProvesExternal } from "./scip-resolution.js";
import {
  RustAnalyzerScipSymbolResolutionStrategy,
  RustBareSelfMethodSymbolResolutionStrategy,
  rustCalleeShortNameCandidates,
  rustCallIsMacroInvocation,
  RustGlobalShortNameSymbolResolutionStrategy,
  RustImportMatchSymbolResolutionStrategy,
  RustLocalBindingSymbolResolutionStrategy,
  RustMacroInvocationSymbolResolutionStrategy,
  rustMacroShortNameCandidates,
  RustSelfFieldSymbolResolutionStrategy,
  RustSelfMethodSymbolResolutionStrategy,
  RustTraitSelfMethodSymbolResolutionStrategy,
  RustTypeReceiverSymbolResolutionStrategy,
  type ResolverConfig,
} from "./strategies/index.js";

export class RustCallResolver implements CallResolver {
  readonly language = "rust";
  readonly strategies: readonly SymbolResolutionStrategy[];
  private readonly dispatchComponents: readonly DispatchResolverComponent[];
  private readonly external = new RustExternalVocabulary();
  private readonly environments: RustResolveEnvironmentCache;

  /**
   * `manifestFilesReader` reads the project's Cargo.toml files for the
   * workspace crate map (bd tea-rags-mcp-sjego); `signatureSources` locates
   * and caches the external signature table (bd s3i8m.7). Both injected by
   * `LanguageFactory` — the resolver never walks the disk; absent, no crate
   * name is known and a bare path head is judged by the symbol table alone,
   * and no external signature is known. `scipSource` acquires the
   * rust-analyzer SCIP index before the pass (bd s3i8m.6 R2b); absent, none is.
   */
  constructor(
    mode: AmbiguousResolveMode = DEFAULT_AMBIGUOUS_RESOLVE_MODE,
    manifestFilesReader?: ManifestFilesReader,
    signatureSources?: RustExternalSignatureSources,
    scipSource?: RustAnalyzerScipSource,
  ) {
    this.environments = new RustResolveEnvironmentCache(manifestFilesReader, signatureSources, scipSource);
    const cfg: ResolverConfig = { mode };
    this.dispatchComponents = [new ConeDispatchResolver(new RustConeTypeLocator(cfg), 8)];
    this.strategies = [
      new RustMacroInvocationSymbolResolutionStrategy(cfg),
      new RustSelfMethodSymbolResolutionStrategy(cfg),
      new RustSelfFieldSymbolResolutionStrategy(cfg),
      new RustLocalBindingSymbolResolutionStrategy(cfg),
      new RustTypeReceiverSymbolResolutionStrategy(cfg),
      new RustImportMatchSymbolResolutionStrategy(cfg),
      new RustBareSelfMethodSymbolResolutionStrategy(cfg),
      new RustGlobalShortNameSymbolResolutionStrategy(cfg),
      // Last: a trait-provided `self.m()` answers only where every pass above stayed silent.
      new RustTraitSelfMethodSymbolResolutionStrategy(cfg),
      // After every name pass: rust-analyzer's own answer for the residual (bd s3i8m.6 R3a).
      new RustAnalyzerScipSymbolResolutionStrategy(cfg),
    ];
  }

  /**
   * The pass-start seam: re-read the workspace's Cargo.toml crate map and
   * load the external signature table before the first call resolves.
   */
  prepareResolvePass(plan: SymbolResolutionPassPlan): void {
    this.environments.reload(plan.projectRoot);
  }

  /** Awaited before `prepareResolvePass`: acquire the project's rust-analyzer SCIP index (bd s3i8m.6 R2b). */
  async warmResolvePass(plan: SymbolResolutionPassPlan): Promise<void> {
    await this.environments.warm(plan);
  }

  /** How the pass's rust-analyzer SCIP acquisition settled; undefined before one ran. */
  diagnostics(): Record<string, unknown> | undefined {
    const rustAnalyzerScip = this.environments.scipDiagnostics();
    return rustAnalyzerScip === undefined ? undefined : { rustAnalyzerScip };
  }

  /** The caller's ctx carrying this run's resolve environment — the one entry every Rust helper reads it from. */
  private withEnvironment(ctx: CallContext): CallContext {
    return withRustResolveEnvironment(ctx, this.environments.forRoot(ctx.projectRoot));
  }

  resolveDispatch(call: CallRef, ctx: CallContext) {
    return resolveDispatchViaComponents(this.dispatchComponents, call, this.withEnvironment(ctx));
  }

  resolve(call: CallRef, ctx: CallContext): SymbolResolutionTarget | null {
    return resolveViaChain(this.strategies, call, this.withEnvironment(ctx));
  }

  /**
   * The miss classifier's first gate: a call the vocabulary can PROVE
   * targets std or an external crate leaves the resolve-rate denominator.
   * Every verdict is proof-based — a project namesake vetoes the std
   * reading, and absence of evidence is never a `true`.
   *
   * rust-analyzer's SCIP answer joins it only where the member has a project
   * namesake (bd s3i8m.6 R3a): Rust has no later classifier gate, so the
   * conjunct moves exactly the rows that would be `missWithInProjectDef` and
   * leaves `noInProjectDef` and the vocabulary's own verdicts byte-identical.
   */
  targetsExternalImport(call: CallRef, ctx: CallContext): boolean {
    const environment = this.withEnvironment(ctx);
    if (this.external.targetsExternal(call, environment)) return true;
    return rustScipProvesExternal(call, environment) && this.hasInProjectDefinition(call, environment);
  }

  /**
   * The miss classifier's denominator question: does a RUST file declare a
   * callable of this member's name (bd tea-rags-mcp-t5cji)? The chain only
   * lands on Rust files, so a namesake a `.py` / `.ts` file declares is no
   * edge this call can have — the runner's unfiltered fallback charged it
   * as an in-project miss anyway. A macro invocation asks the macro
   * namespace instead: `matches!` is no miss because of `fn matches`
   * (bd tea-rags-mcp-s3i8m.2).
   */
  hasInProjectDefinition(call: CallRef, ctx: CallContext): boolean {
    const candidates = rustCallIsMacroInvocation(call)
      ? rustMacroShortNameCandidates(ctx, call.member)
      : rustCalleeShortNameCandidates(ctx, call.member);
    return candidates.length > 0;
  }
}
