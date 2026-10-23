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
 *  -1. rustcCallSites (the rustc driver's type-checked callee for the member
 *      token — the AUTHORITY over every static pass where it has a row:
 *      an in-project answer re-targets, an external or derived one DROPs, an
 *      unmapped or absent one CONTINUEs into the static chain unchanged —
 *      RESIDUAL R2)
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
 *      member token, mapped onto a table symbol — where the driver had no row)
 */

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  emptyDispatchFanout,
  type AmbiguousResolveMode,
  type CallContext,
  type CallRef,
  type CallResolver,
  type DispatchFanoutOutcome,
  type SymbolResolutionPassPlan,
  type SymbolResolutionTarget,
} from "../../../../contracts/types/codegraph.js";
import type {
  DispatchResolverComponent,
  ManifestFilesReader,
  RustAnalyzerScipSource,
  RustCallSiteSource,
  RustExternalSignatureSources,
  SymbolResolutionStrategy,
} from "../../../../contracts/types/language.js";
import { ConeDispatchResolver, resolveDispatchViaComponents, resolveViaChain } from "../../kernel/index.js";
import { RustExternalVocabulary } from "../vocabulary/external-call.js";
import { RustResolveEnvironmentCache } from "./resolve-environment-cache.js";
import { withRustResolveEnvironment } from "./resolve-environment.js";
import { RustConeTypeLocator } from "./rust-cone-type-locator.js";
import {
  rustCallSiteProvesExternal,
  rustCallSiteProvesIndirectCallee,
  rustCallSiteProvesNoProjectCallable,
} from "./scip-resolution.js";
import {
  RustAnalyzerScipSymbolResolutionStrategy,
  RustBareSelfMethodSymbolResolutionStrategy,
  rustCalleeShortNameCandidates,
  rustCallIsMacroInvocation,
  RustcCallSiteSymbolResolutionStrategy,
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
  private readonly callSites: RustcCallSiteSymbolResolutionStrategy;
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
   * `callSiteSource` acquires the rustc call-site index the same way
   * (bd s3i8m T6).
   */
  constructor(
    mode: AmbiguousResolveMode = DEFAULT_AMBIGUOUS_RESOLVE_MODE,
    manifestFilesReader?: ManifestFilesReader,
    signatureSources?: RustExternalSignatureSources,
    scipSource?: RustAnalyzerScipSource,
    callSiteSource?: RustCallSiteSource,
  ) {
    this.environments = new RustResolveEnvironmentCache(
      manifestFilesReader,
      signatureSources,
      scipSource,
      callSiteSource,
    );
    const cfg: ResolverConfig = { mode };
    this.dispatchComponents = [new ConeDispatchResolver(new RustConeTypeLocator(cfg), 8)];
    this.callSites = new RustcCallSiteSymbolResolutionStrategy(cfg);
    this.strategies = [
      // First: where the rustc driver has a row at the member token, its
      // type-checked answer wins over every static pass (RESIDUAL R2).
      this.callSites,
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
      // After every name pass: rust-analyzer's SCIP answer for the residual
      // the driver left (bd s3i8m.6 R3a).
      new RustAnalyzerScipSymbolResolutionStrategy(cfg),
    ];
  }

  /**
   * The pass-start seam: re-read the workspace's Cargo.toml crate map and
   * load the external signature table before the first call resolves.
   */
  prepareResolvePass(plan: SymbolResolutionPassPlan): void {
    this.environments.reload(plan.projectRoot);
    this.callSites.beginPass();
  }

  /**
   * Awaited before `prepareResolvePass`: acquire the project's rust-analyzer
   * SCIP index (bd s3i8m.6 R2b) and rustc call-site index (bd s3i8m T6).
   */
  async warmResolvePass(plan: SymbolResolutionPassPlan): Promise<void> {
    await this.environments.warm(plan);
  }

  /** How the pass's compiler-index acquisitions settled; undefined before any ran. */
  diagnostics(): Record<string, unknown> | undefined {
    const rustAnalyzerScip = this.environments.scipDiagnostics();
    const acquired = this.environments.callSiteDiagnostics();
    const inProjectUnmapped = this.callSites.unmappedInProjectCount();
    const localCallee = this.callSites.localCalleeCount();
    const generated = this.callSites.generatedCount();
    const generatedUnmapped = this.callSites.generatedUnmappedCount();
    const rustcCallSites =
      acquired === undefined
        ? acquired
        : {
            ...acquired,
            ...(inProjectUnmapped === 0 ? {} : { inProjectUnmapped }),
            ...(localCallee === 0 ? {} : { localCallee }),
            ...(generated === 0 ? {} : { generated }),
            ...(generatedUnmapped === 0 ? {} : { generatedUnmapped }),
          };
    if (rustAnalyzerScip === undefined && rustcCallSites === undefined) return undefined;
    return {
      ...(rustAnalyzerScip === undefined ? {} : { rustAnalyzerScip }),
      ...(rustcCallSites === undefined ? {} : { rustcCallSites }),
    };
  }

  /** The caller's ctx carrying this run's resolve environment — the one entry every Rust helper reads it from. */
  private withEnvironment(ctx: CallContext): CallContext {
    return withRustResolveEnvironment(ctx, this.environments.forRoot(ctx.projectRoot));
  }

  /** The trait cone — unless the driver's row decides the call (RESIDUAL R2): then the chain answers it alone. */
  resolveDispatch(call: CallRef, ctx: CallContext): DispatchFanoutOutcome {
    const environment = this.withEnvironment(ctx);
    if (this.callSites.overridesDispatch(call, environment)) return emptyDispatchFanout();
    return resolveDispatchViaComponents(this.dispatchComponents, call, environment);
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
   * The compiler's answer — the rustc driver's, else rust-analyzer's SCIP
   * answer (bd s3i8m T7) — joins it only where the member has a project
   * namesake (bd s3i8m.6 R3a): Rust has no later classifier gate, so the
   * conjunct moves exactly the rows that would be `missWithInProjectDef` and
   * leaves `noInProjectDef` and the vocabulary's own verdicts byte-identical.
   */
  targetsExternalImport(call: CallRef, ctx: CallContext): boolean {
    const environment = this.withEnvironment(ctx);
    if (this.external.targetsExternal(call, environment)) return true;
    return rustCallSiteProvesExternal(call, environment) && this.hasInProjectDefinition(call, environment);
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
    if (candidates.length === 0) return false;
    // A compiler-proven in-project type or local (bd s3i8m.6 R3b) or derived
    // impl (bd s3i8m T7) is no namesake's edge.
    return !rustCallSiteProvesNoProjectCallable(call, this.withEnvironment(ctx));
  }

  /**
   * The miss classifier's LAST gate (K11): the rustc driver proves the callee
   * is a closure, fn pointer or Fn-bound param (RESIDUAL R4), so the target is
   * decided at run time. Proof only — no driver row answers false.
   */
  targetsUndecidable(call: CallRef, ctx: CallContext): boolean {
    return rustCallSiteProvesIndirectCallee(call, this.withEnvironment(ctx));
  }
}
