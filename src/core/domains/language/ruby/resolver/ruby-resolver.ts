/**
 * Ruby implementation of the `CallResolver` contract.
 *
 * `resolve` runs an ordered chain of single-purpose `SymbolResolutionStrategy`
 * passes (see `./strategies/`) via the shared `resolveViaChain` engine. The
 * array order encodes precedence, and the three-state outcome
 * (resolved / drop / continue) makes the load-bearing guard drops explicit —
 * e.g. `super`/`zsuper` without a resolvable ancestor DROPS rather than falling
 * through to the bare-call fallback that would fabricate a wrong edge
 * (bd tea-rags-mcp-jsa0 / lttd; same family as the TS bug 4rgg).
 *
 * Two channels per the ruby-walker output flow through the chain:
 *
 *   1. Explicit `require`/`require_relative` — importText carries the string
 *      literal (with a "./" prefix for relative); resolved by the
 *      `explicitRequire` pass via basename / filesystem-relative match.
 *   2. Zeitwerk constant references — importText starts with the `zeitwerk:`
 *      prefix; resolved by the `constant` pass over the symbol table's known
 *      file paths (the `resolveConstant` helper shared with local-type / super).
 *
 * The pass order (each `name` in parens):
 *   1. super (super/zsuper via classAncestors — terminal guard)
 *   2. selfMember (explicit self.X via enclosing class + classAncestors — terminal guard)
 *   3. localType (receiver.X via walker-bound local type — terminal guard)
 *   4. ivarField (@ivar.X via walker-inferred classFieldTypes — terminal guard)
 *   5. returnTypeBinding (x.X via localCallBindings + functionReturnTypes — additive)
 *   6. constant (Zeitwerk-style Constant.X via resolveConstant)
 *   7. explicitRequire (receiver names a require / require_relative import)
 *   8. arRelationGuard (AR::Relation chain receiver — terminal guard)
 *   9. receiverSetDrop (any remaining receiver-set call — terminal guard)
 *  10. bareCall (bare-call global short-name fallback — last pass)
 */

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  type AmbiguousResolveMode,
  type CallContext,
  type CallRef,
  type CallResolver,
  type DispatchEdge,
  type FileExtraction,
  type GraphEdges,
  type SymbolResolutionTarget,
} from "../../../../contracts/types/codegraph.js";
import type { DispatchResolverComponent, SymbolResolutionStrategy } from "../../../../contracts/types/language.js";
import { ExternalCallClassifier } from "../../external-classifier.js";
import { resolveDispatchViaComponents, resolveViaChain } from "../../resolver-chain.js";
import { ZEITWERK_PREFIX } from "../walker/walker.js";
import { RubyExternalVocabulary } from "./ruby-external-vocabulary.js";
import {
  CONE_MAX_DEFAULT,
  resolveConstant,
  RubyArRelationGuardSymbolResolutionStrategy,
  RubyBareCallSymbolResolutionStrategy,
  RubyConeDispatchResolver,
  RubyConstantSymbolResolutionStrategy,
  RubyDynamicDispatchResolver,
  RubyExplicitRequireSymbolResolutionStrategy,
  RubyIvarFieldSymbolResolutionStrategy,
  RubyLocalTypeSymbolResolutionStrategy,
  RubyReceiverSetDropSymbolResolutionStrategy,
  RubyReturnTypeBindingSymbolResolutionStrategy,
  RubySelfMemberSymbolResolutionStrategy,
  RubySuperSymbolResolutionStrategy,
  RubyTableDispatchResolver,
  type ResolverConfig,
} from "./strategies/index.js";

/** Parse `CODEGRAPH_RB_DYNAMIC_CONFIDENCE` (a float in `(0,1]`); `undefined` on absent/invalid. */
function resolveDynamicConfidence(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : undefined;
}

/** Parse `CODEGRAPH_RB_CONE_MAX`; fall back to the shared default on absent/invalid. */
function resolveConeMax(raw: string | undefined): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : CONE_MAX_DEFAULT;
}

export class RubyCallResolver implements CallResolver {
  readonly language = "ruby";
  private readonly strategies: SymbolResolutionStrategy[];
  private readonly table: RubyTableDispatchResolver;
  private readonly cone: RubyConeDispatchResolver;
  private readonly dynamic: RubyDynamicDispatchResolver;
  private readonly dispatchComponents: readonly DispatchResolverComponent[];
  private readonly externalClassifier: ExternalCallClassifier;

  constructor(private readonly mode: AmbiguousResolveMode = DEFAULT_AMBIGUOUS_RESOLVE_MODE) {
    const cfg: ResolverConfig = {
      mode,
      coneMax: resolveConeMax(process.env.CODEGRAPH_RB_CONE_MAX),
      dynamicReceiverConfidence: resolveDynamicConfidence(process.env.CODEGRAPH_RB_DYNAMIC_CONFIDENCE),
    };
    this.strategies = [
      new RubySuperSymbolResolutionStrategy(cfg),
      new RubySelfMemberSymbolResolutionStrategy(cfg),
      new RubyLocalTypeSymbolResolutionStrategy(cfg),
      new RubyIvarFieldSymbolResolutionStrategy(cfg),
      new RubyReturnTypeBindingSymbolResolutionStrategy(cfg),
      new RubyConstantSymbolResolutionStrategy(cfg),
      new RubyExplicitRequireSymbolResolutionStrategy(cfg),
      new RubyArRelationGuardSymbolResolutionStrategy(cfg),
      new RubyReceiverSetDropSymbolResolutionStrategy(cfg),
      new RubyBareCallSymbolResolutionStrategy(cfg),
    ];
    this.table = new RubyTableDispatchResolver(cfg);
    this.cone = new RubyConeDispatchResolver(cfg);
    this.dynamic = new RubyDynamicDispatchResolver(cfg);
    this.dispatchComponents = [this.table, this.cone, this.dynamic];
    this.externalClassifier = new ExternalCallClassifier(new RubyExternalVocabulary());
  }

  resolve(call: CallRef, ctx: CallContext): SymbolResolutionTarget | null {
    return resolveViaChain(this.strategies, call, ctx);
  }

  /**
   * tea-rags-mcp-ykj7 / cai0 — external-import classifier for an UNRESOLVED call.
   * Delegates to the language-neutral `ExternalCallClassifier`; the Ruby
   * predicates (bare-call framework/kernel vocabulary via the `dsl/` registry,
   * constant-receiver gem/stdlib detection via `resolveConstant`) live in
   * `RubyExternalVocabulary`.
   */
  targetsExternalImport(call: CallRef, ctx: CallContext): boolean {
    return this.externalClassifier.targetsExternal(call, ctx);
  }

  /**
   * Fan-out resolution for a Ruby call, composed in precedence order:
   *
   *   1. Registry-literal table (bd tea-rags-mcp-pq02v) — a `CONST[k].new.m`
   *      site the walker tagged with `call.dispatch` fans out to each value
   *      class's `#m` (`registry`/`1/N`, or `exact`/`1.0` for a static key).
   *      Most specific: the call carries a concrete `CONST` + a statically
   *      complete value set. Returns `[]` for every call without `call.dispatch`.
   *   2. CHA cone (bd tea-rags-mcp-2jet) — a polymorphic TYPED receiver whose
   *      static type has subtypes overriding the member fans out to N `cone`
   *      edges (or one `poly-base`). Returns `[]` for every non-polymorphic
   *      call.
   *   3. Dynamic-receiver fan-out (bd tea-rags-mcp-wbj3) — an UNTYPED dynamic
   *      receiver (`arr.map`, `obj[k].call`) that would otherwise DROP resolves
   *      via discounted short-name lookup to N `dynamic` edges.
   *
   * Table precedes cone/dynamic by specificity, not conflict: a registry
   * dispatch site is gated on `call.dispatch` (set only for `CONST[k].new.m`),
   * which the cone/dynamic receiver shapes never carry, so a non-dispatch call
   * makes the table component return `[]` immediately and the existing
   * cone→dynamic order is unaffected. Cone precedes dynamic: the cone requires a
   * `localBinding` (typed receiver) while the dynamic fan-out explicitly excludes
   * bound receivers, so the two are mutually exclusive by receiver shape. When
   * ALL THREE return `[]` the provider takes the exact `resolve` chain. An
   * `external` receiver carries no in-project target on any path, so the
   * invariant "external never fabricates an out-of-project edge" holds.
   */
  resolveDispatch(call: CallRef, ctx: CallContext): DispatchEdge[] {
    return resolveDispatchViaComponents(this.dispatchComponents, call, ctx);
  }

  /**
   * Build Ruby file→file edges from three channels, all folded into one
   * `fileEdges[]` so they share fanIn/fanOut (tea-rags-mcp; spec
   * 2026-06-05-ruby-file-edges-zeitwerk-inheritance-design):
   *
   *   1. Explicit `require` / `require_relative` — synthesised through the
   *      strategy chain with the require basename as receiver (parity with the
   *      provider's legacy `defaultImportFileEdges` loop).
   *   2. Zeitwerk constant refs — the `imports[]` entries the walker prefixes
   *      with `zeitwerk:`. The prefix is stripped HERE (the provider must not
   *      know the channel) so the bare constant flows into the `constant`
   *      strategy's `resolveConstant`, which the prefixed string would fail.
   *   3. Inheritance / mixins — for every class this file declares, each
   *      `classAncestors` (superclass + include + extend) and
   *      `classPrependedAncestors` (prepend) constant is resolved to its
   *      declaring file via the same `resolveConstant`.
   *
   * Self-edges (constant/ancestor declared in the same file) are skipped, and
   * targets are de-duplicated per file so fanOut counts distinct dependencies.
   */
  resolveFileEdges(extraction: FileExtraction, ctx: CallContext): GraphEdges["fileEdges"] {
    const fileEdges: GraphEdges["fileEdges"] = [];
    const seenTargets = new Set<string>();
    const add = (targetRelPath: string | null, importText: string): void => {
      if (!targetRelPath || targetRelPath === extraction.relPath) return; // self-loop guard
      if (seenTargets.has(targetRelPath)) return; // dedup by target file
      seenTargets.add(targetRelPath);
      fileEdges.push({ targetRelPath, importText });
    };

    // Channels 1 + 2 — explicit require + Zeitwerk constant refs (imports[]).
    for (const imp of extraction.imports) {
      const isZeitwerk = imp.importText.startsWith(ZEITWERK_PREFIX);
      const receiver = isZeitwerk ? imp.importText.slice(ZEITWERK_PREFIX.length) : requireBasename(imp.importText);
      const target = this.resolve(
        { callText: imp.importText, receiver, member: receiver, startLine: imp.startLine },
        ctx,
      );
      if (target) add(target.targetRelPath, imp.importText);
    }

    // Channel 3 — inheritance / mixins (superclass, include, extend, prepend).
    for (const ancestorMap of [extraction.classAncestors, extraction.classPrependedAncestors]) {
      if (!ancestorMap) continue;
      for (const ancestors of Object.values(ancestorMap)) {
        for (const ancestorConst of ancestors) add(resolveConstant(ancestorConst, ctx), ancestorConst);
      }
    }

    return fileEdges;
  }
}

/**
 * Basename of a require importText — segment after the final "/", else the
 * whole string. Mirrors the provider's `lastSegment` for require paths
 * (`"./foo"` → `"foo"`, `"foo"` → `"foo"`): require texts carry no `#`/`.`
 * separators, so a slash-only split reproduces the legacy synthesis exactly.
 */
function requireBasename(importText: string): string {
  const slash = importText.lastIndexOf("/");
  return slash === -1 ? importText : importText.slice(slash + 1);
}
