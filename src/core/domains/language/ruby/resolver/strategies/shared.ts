/**
 * Shared inputs and helpers for the Ruby symbol-resolution strategies.
 *
 * `ResolverConfig` is the per-resolver config every strategy receives by
 * constructor injection (the old `RubyCallResolver(mode)` single field).
 *
 * `resolveConstant` and `collectKnownPaths` are the helpers more than one
 * strategy shares — constant resolution drives the local-type, Zeitwerk-constant
 * and super passes, and the known-paths set feeds both Zeitwerk convention
 * lookup and the explicit-require path resolution. Factored here so they live
 * once.
 */

import {
  pickSingleCandidate,
  type AmbiguousResolveMode,
  type CallContext,
  type SymbolDefinition,
  type SymbolResolutionTarget,
} from "../../../../../contracts/types/codegraph.js";
import { ZEITWERK_PREFIX } from "../../walker/walker.js";
import { linearizeAncestors } from "../ancestor-linearization.js";
import { resolveZeitwerkConstant } from "../zeitwerk.js";

export interface ResolverConfig {
  mode: AmbiguousResolveMode;
  /**
   * Max cone size before CHA devirtualization collapses to a single
   * `poly-base` edge (bd tea-rags-mcp-2jet). `|cone| ≤ coneMax` persists N
   * `cone` edges (confidence `1/N`); `> coneMax` persists one base-decl edge
   * expanded at query time. Defaults to `CONE_MAX_DEFAULT` (8) when omitted.
   */
  coneMax?: number;
  /**
   * Confidence weight applied to a dynamic-receiver short-name fan-out edge
   * (bd tea-rags-mcp-wbj3) BEFORE the per-candidate `1/N` split. A dynamic
   * receiver (`arr.map`, `obj[k].call`) carries no static type, so its
   * short-name match is materially weaker than a CHA `cone` candidate (which at
   * least has a static base type) — this discount marks that. Defaults to
   * `DYNAMIC_RECEIVER_CONFIDENCE_DEFAULT` (0.5) when omitted; env
   * `CODEGRAPH_RB_DYNAMIC_CONFIDENCE` overrides at composition.
   */
  dynamicReceiverConfidence?: number;
}

/** Default cone-size threshold; env `CODEGRAPH_RB_CONE_MAX` overrides at composition. */
export const CONE_MAX_DEFAULT = 8;

/**
 * Default confidence discount for a dynamic-receiver short-name fan-out edge
 * (bd tea-rags-mcp-wbj3). A name-only match with no type evidence — discounted
 * to half so ranking treats it as a weak, speculative edge that still beats
 * dropping the call entirely. The per-edge confidence is this value divided by
 * the candidate count `N`. Env `CODEGRAPH_RB_DYNAMIC_CONFIDENCE` overrides.
 */
export const DYNAMIC_RECEIVER_CONFIDENCE_DEFAULT = 0.5;

/**
 * Whether a symbol-table relPath is a Ruby file the resolver may attribute a
 * call edge to. The symbol table is language-agnostic (no `language` field on
 * `SymbolDefinition`), so a Ruby resolver gates on the file extension to avoid
 * attributing an edge to a vendored JS / Java / etc. definition (bug pl7k:
 * `agents.map(&:id)` → `d3.js#map`). Shared by the bare-call fallback and the
 * dynamic-receiver fan-out (both do cross-language short-name lookups).
 */
export function isRubyPath(relPath: string): boolean {
  return relPath.endsWith(".rb") || relPath.endsWith(".rake") || relPath.endsWith(".gemspec");
}

/**
 * True when a call receiver's OUTERMOST operation is an element reference
 * (`recv[k]`, `arr[i]`, `[1,2,3]`) — the trimmed text ends in `]` and contains a
 * `[`. An index on an untyped container yields an element whose type is
 * statically untrackable (Hash/Array element → core/external), so the dynamic
 * resolver must NOT fan out to same-named in-project methods. A chain off an
 * index (`a[0].b`) ends in `b`, not `]`, so it is correctly excluded (outermost
 * op is the chain — deferred to increment B). Text-shape, mirroring
 * `receiverLooksLikeArRelationChain` (bd tea-rags-mcp-mktkk increment A).
 */
export function receiverIsIndexAccess(receiver: string): boolean {
  const t = receiver.trimEnd();
  return t.endsWith("]") && t.includes("[");
}

/**
 * Provably-external chain tails — Ruby-core / Rails-runtime methods that a chain
 * receiver dispatches on (`req.headers.to_h`, `e.backtrace.first`,
 * `type.constantize`). NARROW + unambiguous on purpose: in-project association
 * tails (`agents`, `user`) are absent, so `event.user.agents` is never
 * suppressed. High-frequency / in-project-overridable tails (`.map`/`.each`/
 * `.first`, and `.to_h`/`.to_json` which Rails models & serializers routinely
 * define) are EXCLUDED (deferred — they need a root-segment vocab gate). bd
 * Increment B / B-suppress.
 */
const EXTERNAL_CHAIN_TAILS = [".headers", ".backtrace", ".constantize", ".deconstantize", ".to_param", ".class_name"];

/**
 * True when a chain receiver ends in a provably-external core/runtime method —
 * the receiver text contains one of {@link EXTERNAL_CHAIN_TAILS} as a suffix
 * segment. Text-shape, mirroring `receiverIsIndexAccess` /
 * `receiverLooksLikeArRelationChain`.
 */
export function receiverChainTailIsExternal(receiver: string): boolean {
  const t = receiver.trimEnd();
  return EXTERNAL_CHAIN_TAILS.some((tail) => t.endsWith(tail));
}

/** Last `::`-segment of a (possibly qualified) Ruby constant — `A::B::C` → `C`. */
/**
 * A real `def` SHADOWS the schema-synthesized accessor of the same name — Ruby
 * generates column methods into a module the model includes, so an explicit
 * `def name` in the class body wins (bd tea-rags-mcp-8l5fo). Applied after the
 * file/scope narrowing so a model carrying both never looks AMBIGUOUS to
 * `pickSingleCandidate` and degrades to a file-only edge.
 */
export function preferDeclaredOverSchemaColumn(defs: SymbolDefinition[]): SymbolDefinition[] {
  const declared = defs.filter((def) => def.isSchemaColumn !== true);
  return declared.length > 0 ? declared : defs;
}

export function lastConstantSegment(qualified: string): string {
  const parts = qualified.split("::");
  return parts[parts.length - 1] ?? qualified;
}

/**
 * Resolve a (possibly qualified) Ruby constant to the file that DECLARES it.
 *
 *   - Pass 1: direct qualified-name lookup in the symbol table — every file's
 *     fileScope[] carries its declared constants via the walker, so this works
 *     without conventions.
 *   - Pass 2: enclosing-scope walk (Ruby's `Module.nesting`). When a bare
 *     constant is referenced from inside a (possibly nested) class/module, Ruby
 *     walks the enclosing scopes outward looking for `<scope>::<receiver>`
 *     before falling back to the top level (bug ohz5). Only applies when the
 *     receiver itself is unqualified.
 *   - Pass 3: Zeitwerk convention against known file paths.
 *
 * Shared by the local-type, Zeitwerk-constant and super passes.
 */
export function resolveConstant(qualified: string, ctx: CallContext): string | null {
  const direct = ctx.symbolTable.lookup(qualified);
  if (direct.length === 1) return direct[0].relPath;
  if (!qualified.includes("::") && ctx.callerScope.length > 0) {
    for (let i = ctx.callerScope.length; i > 0; i--) {
      const prefix = ctx.callerScope.slice(0, i).join("::");
      const candidate = `${prefix}::${qualified}`;
      const matches = ctx.symbolTable.lookup(candidate);
      if (matches.length === 1) return matches[0].relPath;
    }
  }
  return resolveZeitwerkConstant(qualified, collectKnownPaths(ctx));
}

/**
 * The set of distinct file paths the resolver can range over for basename /
 * Zeitwerk convention matching: every non-Zeitwerk import's text plus the
 * caller file (so basename match has at least the local set). Shared by
 * `resolveConstant` (Zeitwerk convention) and the explicit-require path
 * resolution.
 */
export function collectKnownPaths(ctx: CallContext): Iterable<string> {
  const paths = new Set<string>();
  for (const imp of ctx.imports) {
    if (!imp.importText.startsWith(ZEITWERK_PREFIX)) paths.add(imp.importText);
  }
  paths.add(ctx.callerFile);
  return paths;
}

/**
 * Flatten a class's ancestor chain into a declaration-order list, cycle-guarded
 * via a `visited` set (mirrors the depth-first traversal inside
 * `resolveInstanceMethodInClassChain`). `klass` itself is NOT included — the
 * caller decides whether to prepend it.
 *
 * Kept separate from `resolveInstanceMethodInClassChain`: that function
 * interleaves per-node file resolution + method lookup with a
 * method-pin-wins-immediately short-circuit, which a pre-flattened list cannot
 * express without losing the early return. This helper is the pure structural
 * traversal.
 *
 * **STORAGE order, deliberately unranked** (bd tea-rags-mcp-ymht3). Its one
 * consumer, `superTargetsExternal`, asks whether EVERY ancestor is out of
 * project — a membership question, where reordering is a no-op that would still
 * pay for a full {@link linearizeAncestors} pass per node on every `super`
 * classification. A consumer that instead takes the FIRST ancestor to answer
 * needs {@link collectResolvedAncestorChain}, which ranks; the bare-call
 * narrowing moved there for the FQ canonicalization it also needs (lawlq.3.4).
 */
export function collectAncestorChain(klass: string, ctx: CallContext, visited: Set<string> = new Set()): string[] {
  if (visited.has(klass)) return [];
  visited.add(klass);
  const chain: string[] = [];
  const ancestors = ctx.classAncestors?.[klass];
  if (ancestors) {
    for (const ancestor of ancestors) {
      if (visited.has(ancestor)) continue;
      chain.push(ancestor);
      chain.push(...collectAncestorChain(ancestor, ctx, visited));
    }
  }
  return chain;
}

/**
 * FQ-canonicalize a raw ancestor name to the key form used by `classAncestors`
 * / the symbol table, applying Ruby lexical-nesting resolution relative to
 * `nestingKlass`. `classAncestors` is keyed by each class's FQ but stores its
 * ancestor VALUES as the raw source text (`class D < Introspection::BaseObject`
 * stores `"Introspection::BaseObject"`), so a raw-string recursion dead-ends at
 * the first hop whose real key is namespaced (`GraphQL::Introspection::BaseObject`).
 * Returns the resolved FQ, or null when nothing matches (caller keeps the raw).
 *
 * Covers the NESTING half of Ruby constant lookup: `Module.nesting` — whose HEAD
 * is the declaring class/module itself — then the outer prefixes. Each hop is a
 * single symbol-table probe, and keeping it that way is deliberate: this runs
 * inside the ancestor-chain walk on every bare-call narrowing, so its per-call
 * cost is multiplied by the whole corpus. The cref-ANCESTOR half of the lookup
 * costs a probe per ancestor and lives in {@link canonicalizeMixinAlias}, whose
 * call count is bounded by one module's includer list (bd lawlq.5).
 */
function canonicalizeAncestorFq(raw: string, nestingKlass: string, ctx: CallContext): string | null {
  // Precision guard (bd lawlq.3.4): a classAncestors key is inherently unique;
  // a symbol-table match must be UNIQUE (=== 1) so an ambiguous namespace prefix
  // never canonicalizes to the wrong FQ and fabricates a mixin edge.
  const isKnown = (name: string): boolean =>
    ctx.classAncestors?.[name] !== undefined || ctx.symbolTable.lookup(name).length === 1;
  // `Module.nesting` HEAD is the declaring class itself: `class C; prepend
  // Wrapper` means `C::Wrapper` whenever that constant exists, shadowing any
  // outer or top-level `Wrapper`. Legal for COMPACT declarations too (`class
  // A::B::C` opens `A::B::C`, just not A / A::B), so this hop runs before the
  // compact bail-out (bd lawlq.5).
  const ownScope = `${nestingKlass}::${raw}`;
  if (isKnown(ownScope)) return ownScope;
  if (isKnown(raw)) return raw;
  // A COMPACT class def (`class A::B::C`) does NOT open the intermediate
  // namespaces A / A::B as lexical scopes — a bare `BaseController` superclass
  // resolves at TOP level (`::BaseController`), never `Api::BaseController`. So
  // the nesting prefix-walk would fabricate a wrong in-project FQ; skip it for
  // compact-declared classes (bd lawlq.3.7). Nested defs keep the walk.
  if (!ctx.compactDeclaredClasses?.has(nestingKlass)) {
    const segs = nestingKlass.split("::");
    // Innermost nesting wins (Ruby constant lookup); try the widest prefix first.
    for (let i = segs.length - 1; i >= 1; i--) {
      const candidate = `${segs.slice(0, i).join("::")}::${raw}`;
      if (isKnown(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * FQ-canonicalize the constant `includer` wrote to mix a module in. Extends
 * {@link canonicalizeAncestorFq} with the second half of Ruby constant lookup —
 * the cref's ANCESTORS — so `class Sub < Base; include Helpers` canonicalizes
 * `Helpers` to `Base::Helpers` (bd lawlq.5).
 *
 * Separate from the nesting-only walk on purpose. This one probes every direct
 * ancestor of the includer, canonicalizing each ancestor's own name first, so
 * its cost scales with the hierarchy's width. That is affordable only here,
 * where the caller is {@link resolveViaIncludingClasses}'s alias retry: at most
 * one call per includer of one module, and only when the FQ key found nothing.
 */
function canonicalizeMixinAlias(alias: string, includer: string, ctx: CallContext): string | null {
  const nested = canonicalizeAncestorFq(alias, includer, ctx);
  if (nested !== null) return nested;
  const isKnown = (name: string): boolean =>
    ctx.classAncestors?.[name] !== undefined || ctx.symbolTable.lookup(name).length === 1;
  const parent = ctx.classExtends?.[includer];
  const ancestors = [...(ctx.classAncestors?.[includer] ?? []), ...(parent === undefined ? [] : [parent])];
  for (const ancestor of ancestors) {
    const ancestorFq = canonicalizeAncestorFq(ancestor, includer, ctx) ?? ancestor;
    const candidate = `${ancestorFq}::${alias}`;
    if (isKnown(candidate)) return candidate;
  }
  return null;
}

/**
 * Like {@link collectAncestorChain} but canonicalizes each ancestor hop to its
 * FQ via {@link canonicalizeAncestorFq} before recursing, so a chain whose
 * `classAncestors` VALUES are raw non-FQ text still reaches the mixin / base
 * that actually owns an inherited DSL method (bd lawlq.3.4 — graphql-ruby
 * `field`/`argument` on the HasFields/HasArguments mixins, 3 hops up an
 * `extend`/superclass chain). Cycle-guarded via `visited`; `klass` itself is
 * NOT included.
 *
 * Direct ancestors are emitted in {@link ancestorsInMroOrder}, not walker
 * storage order (bd tea-rags-mcp-ymht3). Both consumers take the FIRST hop that
 * answers — `bareCall`'s scope tiers and `schemaColumn`'s column match — so the
 * order here IS their precedence rule, and storage order hands them the
 * superclass where Ruby reaches a mixin. ORDER only: the emitted set is the
 * ancestor closure either way, since `visited` dedups by reachability rather
 * than by position.
 */
export function collectResolvedAncestorChain(
  klass: string,
  ctx: CallContext,
  visited: Set<string> = new Set(),
): string[] {
  if (visited.has(klass)) return [];
  visited.add(klass);
  const chain: string[] = [];
  const ancestors = ctx.classAncestors?.[klass];
  if (ancestors) {
    for (const raw of ancestorsInMroOrder(klass, ancestors, ctx)) {
      const fq = canonicalizeAncestorFq(raw, klass, ctx) ?? raw;
      if (visited.has(fq)) continue;
      chain.push(fq);
      chain.push(...collectResolvedAncestorChain(fq, ctx, visited));
    }
  }
  return chain;
}

/**
 * `klass`'s DIRECT ancestors in the order Ruby reaches them, ranked by their
 * position in {@link linearizeAncestors}: every `include` ahead of the
 * superclass, a later `include` ahead of an earlier one, and a module the
 * superclass chain ALREADY carries left behind that superclass rather than
 * hoisted in front of it (bd tea-rags-mcp-mo5ur).
 *
 * Ranking rather than re-deriving "superclass last" locally: the linearization
 * is the one authority on MRO order in this package (`resolveSuper`,
 * {@link firstDefinerAfter} and `selfMemberReturnType` all read it), and its
 * dedup rule is the part a hand-rolled reorder gets wrong.
 *
 * ORDER only. The walk that consumes this keeps its own structure — same
 * ancestors reached, same prepend rule, same file-only fallback — so nothing
 * about WHICH targets are reachable moves, only which one is found first.
 *
 * Ancestors absent from the linearization (a name the hierarchy maps nowhere)
 * sort last in declaration order; a single ancestor short-circuits, because
 * there is no order to fix and the linearization walks the whole ancestor
 * closure to compute one.
 */
function ancestorsInMroOrder(klass: string, ancestors: readonly string[], ctx: CallContext): readonly string[] {
  if (ancestors.length < 2) return ancestors;
  const mro = linearizeAncestors(klass, ctx);
  const rank = (name: string): number => {
    const at = mro.indexOf(name);
    return at === -1 ? Number.MAX_SAFE_INTEGER : at;
  };
  return [...ancestors].sort((a, b) => rank(a) - rank(b));
}

/**
 * Resolve `<member>` as an instance method on `klass`, walking `classAncestors`
 * (superclass + `include`/`extend` mixins) in Ruby's MRO order when the class
 * itself doesn't own it. Shared by the `super` walk (which starts at the
 * ancestors) and the `self.<member>` walk (which starts at the enclosing class
 * itself) so both express the same Ruby MRO traversal once.
 *
 *   1. Resolve `klass` to its declaring file via `resolveConstant`.
 *   2. Within that file, look for `<member>` (short-name match scoped to the
 *      file). A unique candidate is a method-level edge.
 *   3. Miss → recurse into `classAncestors[klass]`, ranked by
 *      {@link ancestorsInMroOrder} and accumulating into `visited` so
 *      `A < B < A` cycles short-circuit. The first ancestor that owns `member`
 *      at the method level wins.
 *   4. File known but method absent anywhere in the chain → file-only edge
 *      (`targetSymbolId: null`) for the FIRST class whose file resolved, keeping
 *      file-level fan accurate for out-of-project parents (`ApplicationRecord`).
 *   5. No class in the chain resolves to a known file → `null` (caller DROPs).
 *
 * `excludeSymbolId` removes ONE definition from every candidate set along the
 * walk. Step 2 pins by short name WITHIN a file, and a module nested in the
 * class it is mixed into shares that file — so the `super` pass passes its own
 * `callerSymbolId` here, because `super` can never dispatch to the method that
 * is executing (bd lawlq.5). Omitted everywhere else: a self-send that resolves
 * to the calling method is ordinary recursion.
 */
export function resolveInstanceMethodInClassChain(
  klass: string,
  member: string,
  ctx: CallContext,
  mode: AmbiguousResolveMode,
  visited: Set<string>,
  excludeSymbolId?: string,
): SymbolResolutionTarget | null {
  if (visited.has(klass)) return null;
  visited.add(klass);

  // `prepend M` inserts M BEFORE the class itself in Ruby's MRO, so a prepended
  // module's method shadows the class's own (and is found before ancestors).
  // Method-level pin required — a file-only edge from a prepend is no better
  // than the class's own file edge. Reverse order: later `prepend` wins in MRO.
  // Mirrors `resolveTypeMethod`; shared so self/super honour prepend like the
  // local-type/ivar passes already do (bd tea-rags-mcp-3jvn family).
  const prepended = ctx.classPrependedAncestors?.[klass];
  if (prepended) {
    for (let i = prepended.length - 1; i >= 0; i--) {
      const inherited = resolveInstanceMethodInClassChain(prepended[i], member, ctx, mode, visited, excludeSymbolId);
      if (inherited && inherited.targetSymbolId !== null) return inherited;
    }
  }

  const klassFile = resolveConstant(klass, ctx);
  let fileOnlyFallback: SymbolResolutionTarget | null =
    klassFile !== null ? { targetRelPath: klassFile, targetSymbolId: null } : null;

  if (klassFile !== null) {
    const candidates = preferDeclaredOverSchemaColumn(
      ctx.symbolTable
        .lookupByShortName(member, { includeSchemaColumns: true })
        .filter((def) => def.relPath === klassFile && def.symbolId !== excludeSymbolId),
    );
    const target = pickSingleCandidate(candidates, mode);
    if (target) return { targetRelPath: target.relPath, targetSymbolId: target.symbolId };
  }

  const ancestors = ctx.classAncestors?.[klass];
  if (ancestors) {
    for (const ancestor of ancestorsInMroOrder(klass, ancestors, ctx)) {
      const inherited = resolveInstanceMethodInClassChain(ancestor, member, ctx, mode, visited, excludeSymbolId);
      if (inherited === null) continue;
      // Method-level pin wins immediately; remember the first known file as a
      // fallback so a file-only ancestor edge survives if nothing pins later.
      if (inherited.targetSymbolId !== null) return inherited;
      if (fileOnlyFallback === null) fileOnlyFallback = inherited;
    }
  }

  return fileOnlyFallback;
}

/**
 * Resolve a receiverless CLASS-BODY self-send via the single-inheritance chain
 * (`ctx.classExtends`) — the concern-consensus analog over `<` rather than
 * `include` (bd tea-rags-mcp-4skzl). A subclass-body DSL macro
 * (`column :name` in `class FooExporter < ApplicationCsvExporter`) has no local
 * def and its enclosing class cannot be pinned by `callerScope` (a class-body
 * chunk's scope OMITS its own name), so the ambiguous global short-name lookup
 * strict-continues and the edge is dropped.
 *
 * Walk `[enclosing, classExtends[enclosing], …]` NEAREST-FIRST (a leaf override
 * shadows an ancestor's def). At each hop resolve the class to its declaring
 * file and pin `member` to a def IN THAT FILE (short-name match filtered to the
 * file — catches a def whose stored scope-tail differs from the class name,
 * e.g. a concern's `ClassMethods`). Single parent per hop (Ruby single
 * inheritance); mixins on the subclass itself are NOT walked — those are a
 * different dispatch, covered by the include/self-send passes.
 *
 * **Method-level ONLY — never a file-only edge.** A class-body macro whose base
 * declares nothing in-project (`validates` on `class User < ApplicationRecord`
 * whose own super `ActiveRecord::Base` is external) MUST stay unresolved so the
 * provider classifies it `externalSkipped` rather than fabricating an edge to
 * the nearest in-project ancestor file. Returning `null` here is the precision
 * gate: no in-project def in the `<` chain ⇒ no edge.
 *
 * Distinct from {@link resolveInstanceMethodInClassChain} (super / self-send
 * passes): that walks the mixin-conflated `classAncestors`
 * (`Record<string, string[]>`) and RETURNS a file-only fallback for
 * out-of-project parents; this walks the pure single-inheritance `classExtends`
 * (`Record<string, string>`) and is method-level only — a bare-call class-body
 * DSL macro must not fabricate a file edge to an external-DSL base.
 *
 * Cycle-guarded via `visited` so `class A < B; class B < A` short-circuits.
 */
export function resolveViaSuperclassChain(
  enclosing: string,
  member: string,
  ctx: CallContext,
  mode: AmbiguousResolveMode,
): SymbolResolutionTarget | null {
  const visited = new Set<string>();
  let klass: string | undefined = enclosing;
  while (klass !== undefined && !visited.has(klass)) {
    visited.add(klass);
    const file = resolveConstant(klass, ctx);
    if (file !== null) {
      const candidates = ctx.symbolTable.lookupByShortName(member).filter((def) => def.relPath === file);
      const target = pickSingleCandidate(candidates, mode);
      if (target) return { targetRelPath: target.relPath, targetSymbolId: target.symbolId };
    }
    klass = ctx.classExtends?.[klass];
  }
  return null;
}

/**
 * The first ancestor AFTER `startAfter` in `klass`'s prepend-aware MRO that
 * defines `member` (bd cai0/2oky5). Linearizes `klass` via
 * {@link linearizeAncestors}, finds `startAfter`, and walks the remainder via
 * `resolveInstanceMethodInClassChain` with a `visited` set pre-seeded up to and
 * including `startAfter` so nothing at or before it is re-walked. Method-level
 * pin wins; file-only is the fallback. Returns `null` when `startAfter` is not in
 * the MRO or nothing after it defines `member`. Backbone-additive — reuses the
 * existing chain walk, does not mutate it.
 *
 * The linearization (rather than `collectAncestorChain`) is what makes "after"
 * mean what Ruby means: includes rank BEFORE the superclass, and within the
 * include region a later `include` ranks nearer than an earlier one
 * (bd tea-rags-mcp-uuux9).
 */
export function firstDefinerAfter(
  startAfter: string,
  member: string,
  klass: string,
  ctx: CallContext,
  mode: AmbiguousResolveMode,
  excludeSymbolId?: string,
): SymbolResolutionTarget | null {
  const mro = linearizeAncestors(klass, ctx);
  const idx = mro.indexOf(startAfter);
  if (idx === -1) return null;
  const visited = new Set<string>(mro.slice(0, idx + 1));
  let fileOnlyFallback: SymbolResolutionTarget | null = null;
  for (let i = idx + 1; i < mro.length; i++) {
    const t = resolveInstanceMethodInClassChain(mro[i], member, ctx, mode, visited, excludeSymbolId);
    if (t === null) continue;
    if (t.targetSymbolId !== null) return t;
    if (fileOnlyFallback === null) fileOnlyFallback = t;
  }
  return fileOnlyFallback;
}

/**
 * Resolve a receiverless self-send whose enclosing scope is a MODULE (concern)
 * via the classes that include it. For each includer in `ctx.includedBy[module]`
 * take `firstDefinerAfter(module, member, includer)` (what the includer resolves
 * `member` to past the module in its MRO) and return the target INVARIANT across
 * all of them: consensus → precision 1.0; ANY disagreement → null (DROP, GUARD).
 * Shared by the `super`-from-module walk (ruby-super) and the bareCall
 * concern-scope fallback (bd tea-rags-mcp-lawlq.3.2 facet-2).
 *
 * `includedBy` is keyed by the RAW ancestor text the include SITE wrote, so a
 * module mixed in under a bare constant (`prepend PerformWrapper` inside
 * `class Tech::BatchOperationWorker`) has no entry under its own FQ. When the FQ
 * key is empty the lookup retries under the module's LAST SEGMENT, keeping only
 * includers whose raw ancestor canonicalizes back to exactly `moduleName` — the
 * precision gate that stops two same-tailed modules from swapping consensus
 * (bd lawlq.5). The alias, not the FQ, is what `firstDefinerAfter` must resume
 * after, because the MRO it linearizes holds the same raw values.
 */
export function resolveViaIncludingClasses(
  moduleName: string,
  member: string,
  ctx: CallContext,
  mode: AmbiguousResolveMode,
  excludeSymbolId?: string,
): SymbolResolutionTarget | null {
  const including = includerAliases(moduleName, ctx);
  if (including.length === 0) return null;
  let agreed: SymbolResolutionTarget | null = null;
  for (const { klass, alias } of including) {
    const t = firstDefinerAfter(alias, member, klass, ctx, mode, excludeSymbolId);
    if (t === null) continue;
    if (agreed === null) {
      agreed = t;
      continue;
    }
    const same =
      agreed.targetSymbolId !== null || t.targetSymbolId !== null
        ? agreed.targetSymbolId === t.targetSymbolId
        : agreed.targetRelPath === t.targetRelPath;
    if (!same) return null; // including classes disagree → DROP
  }
  return agreed;
}

/**
 * The classes that mix `moduleName` in, each paired with the ANCESTOR NAME that
 * class actually wrote — the key `includedBy` is built from and the token
 * `firstDefinerAfter` can locate in a linearized MRO. Direct FQ hits keep the FQ
 * as their alias; the segment retry only contributes an includer when the raw
 * name canonicalizes back to this very module (bd lawlq.5).
 */
function includerAliases(moduleName: string, ctx: CallContext): { klass: string; alias: string }[] {
  const direct = ctx.includedBy?.[moduleName] ?? [];
  if (direct.length > 0) return direct.map((klass) => ({ klass, alias: moduleName }));
  const segment = lastConstantSegment(moduleName);
  if (segment === moduleName) return [];
  const out: { klass: string; alias: string }[] = [];
  for (const klass of ctx.includedBy?.[segment] ?? []) {
    if (canonicalizeMixinAlias(segment, klass, ctx) === moduleName) out.push({ klass, alias: segment });
  }
  return out;
}

/**
 * Resolve `<typeName>#<member>` for a receiver whose static type is KNOWN
 * (walker-inferred local binding `var = ClassName.new`, or `@ivar` field type
 * from `classFieldTypes`):
 *
 *   1. Resolve `typeName` to its declaring file via `resolveConstant`.
 *   2. Check `prepend`ed modules FIRST (reverse MRO; method-level pin required —
 *      a file-only edge from a prepend is no better than the class's own).
 *   3. Within the type's file, look for `<member>` whose scope tail matches the
 *      type (FQ `Product::IndexForm` or bare `PaginatableForm` — both forms exist
 *      in the table depending on how the class header was declared).
 *   4. Miss → walk `classAncestors` in {@link ancestorsInMroOrder} order; the
 *      first ancestor that method-level-pins `<member>` wins.
 *   5. File known but method absent → file-only edge (`targetSymbolId: null`),
 *      keeping file-level fan accurate for out-of-project parents (AR `save`).
 *   6. Type's file unknown (gem / stdlib) → `null` (caller DROPs).
 *
 * Shared by the local-var (`var.X`) and `@ivar.X` type-resolution strategies so
 * the precise scope-tail + prepend + ancestor MRO walk lives once. Distinct from
 * `resolveInstanceMethodInClassChain` (super / self): that matches any short-name
 * in the file and has no prepend step; this pins the scope tail and honours
 * `prepend`.
 */
export function resolveTypeMethod(
  typeName: string,
  member: string,
  ctx: CallContext,
  mode: AmbiguousResolveMode,
): SymbolResolutionTarget | null {
  return resolveTypeMethodInternal(typeName, member, ctx, mode, new Set(), null);
}

/**
 * Resolve `<typeName>#<member>` for an INSTANCE receiver — same MRO walk as
 * `resolveTypeMethod` but explicitly restricts candidates to the instance-method
 * symbolId form (`Type#method`), avoiding ambiguity when both a class method
 * (`Type.method`) and an instance method share the same short name. Use this when
 * the receiver's `LocalBinding.valueKind` is `"instance"` (or absent). Callers
 * that never track `valueKind` (ivar, return-type) keep using `resolveTypeMethod`
 * for backward compatibility.
 */
export function resolveTypeInstanceMethod(
  typeName: string,
  member: string,
  ctx: CallContext,
  mode: AmbiguousResolveMode,
): SymbolResolutionTarget | null {
  return resolveTypeMethodInternal(typeName, member, ctx, mode, new Set(), symbolIdIsInstanceMethod);
}

/**
 * Resolve `<typeName>.<member>` for a CLASS-valued receiver (`var = ClassName`) —
 * same MRO walk as `resolveTypeMethod` but restricts candidates to the class-method
 * symbolId form (`Type.method`) so `klass.find` resolves to `User.find` rather
 * than `User#find`. Mirrors the `.`-form preference already used by
 * `RubyConstantSymbolResolutionStrategy` for direct `Const.method` calls.
 */
export function resolveTypeStaticMethod(
  typeName: string,
  member: string,
  ctx: CallContext,
  mode: AmbiguousResolveMode,
): SymbolResolutionTarget | null {
  return resolveTypeMethodInternal(typeName, member, ctx, mode, new Set(), symbolIdIsClassMethod);
}

/**
 * Narrow a self-dispatch HOOK to its concrete definition on `typeName` — the ONE
 * choke point both narrow-to-1 consumers route through (the constant-entry
 * strategy `RubySelfDispatchEntrySymbolResolutionStrategy` and the
 * instance-rooted `redirectSelfDispatchTemplate`), so the terminal policy is
 * decided once (bd tea-rags-mcp-wceck).
 *
 * `resolveTypeInstanceMethod` walks the MRO, so a type that does NOT override the
 * hook resolves it to the ancestor's definition — and when the base DECLARES the
 * hook as an abstract stub (`raise NotImplementedError` / empty / bare `super`,
 * marked by the walker as `SymbolDefinition.isAbstractStub`), that is exactly the
 * declaration the REDIRECT terminal exists to bypass. Emitting there would point
 * `get_callers` at a stub, so this returns `null` — the same "no narrow" answer
 * as a hook that isn't defined at all, letting each consumer fall through (the
 * strategy CONTINUEs; the redirect keeps its original target).
 *
 * `null` for a file-only resolution too: a narrow is method-level or nothing.
 * Deliberately NOT folded into `resolveTypeInstanceMethod` — a stub is a perfectly
 * good target for an ordinary typed-receiver call (`plain.process_result` really
 * does reach the base declaration); it is only in the hook-narrowing terminal
 * that a stub means "keep looking / keep the original".
 */
export function resolveSelfDispatchHookTarget(
  typeName: string,
  hook: string,
  ctx: CallContext,
  mode: AmbiguousResolveMode,
): SymbolResolutionTarget | null {
  const target = resolveTypeInstanceMethod(typeName, hook, ctx, mode);
  if (target === null) return null;
  if (target.targetSymbolId === null) return null; // file-only — never a narrow
  if (targetIsAbstractStub(target, hook, ctx)) return null;
  return target;
}

/** Whether a resolved hook target points at a walker-marked abstract stub. */
function targetIsAbstractStub(target: SymbolResolutionTarget, hook: string, ctx: CallContext): boolean {
  return ctx.symbolTable
    .lookupByShortName(hook)
    .some(
      (def) =>
        def.symbolId === target.targetSymbolId && def.relPath === target.targetRelPath && def.isAbstractStub === true,
    );
}

function resolveTypeMethodInternal(
  typeName: string,
  member: string,
  ctx: CallContext,
  mode: AmbiguousResolveMode,
  visited: Set<string>,
  symbolIdFilter: ((symbolId: string, member: string) => boolean) | null,
): SymbolResolutionTarget | null {
  if (visited.has(typeName)) return null;
  visited.add(typeName);
  const targetFile = resolveConstant(typeName, ctx);

  // When the class's own file cannot be resolved (e.g. reopened across N>1
  // files so resolveConstant returns null) but classAncestors is present,
  // skip own-file and prepend lookups and fall through to the ancestor walk.
  // Without ancestors there is nothing to resolve — return null so the caller
  // can DROP. (RC-2 fix: tea-rags-mcp-nts2b)
  if (!targetFile && !ctx.classAncestors?.[typeName]) return null;

  if (targetFile !== null) {
    const prepended = ctx.classPrependedAncestors?.[typeName];
    if (prepended) {
      for (let i = prepended.length - 1; i >= 0; i--) {
        const inherited = resolveTypeMethodInternal(prepended[i], member, ctx, mode, visited, symbolIdFilter);
        if (inherited && inherited.targetSymbolId !== null) return inherited;
      }
    }

    const bareType = lastConstantSegment(typeName);
    // Schema columns join HERE and only here on the typed path: the lookup is
    // already narrowed to one class's file and scope, so a synthesized `name`
    // cannot widen anything (bd tea-rags-mcp-8l5fo).
    const candidates = preferDeclaredOverSchemaColumn(
      ctx.symbolTable.lookupByShortName(member, { includeSchemaColumns: true }).filter((def) => {
        if (def.relPath !== targetFile) return false;
        const tail = def.scope[def.scope.length - 1];
        if (tail !== typeName && tail !== bareType) return false;
        return symbolIdFilter === null || symbolIdFilter(def.symbolId, member);
      }),
    );
    const target = pickSingleCandidate(candidates, mode);
    if (target) return { targetRelPath: target.relPath, targetSymbolId: target.symbolId };
  }

  const ancestors = ctx.classAncestors?.[typeName];
  if (ancestors) {
    for (const ancestor of ancestorsInMroOrder(typeName, ancestors, ctx)) {
      const inherited = resolveTypeMethodInternal(ancestor, member, ctx, mode, visited, symbolIdFilter);
      if (inherited && inherited.targetSymbolId !== null) return inherited;
    }
  }

  // File-only fallback is only possible when the class's own file is known.
  // If targetFile is null (reopened class), the ancestor walk is the only
  // resolution path; returning null here lets the caller treat it as unresolved.
  if (targetFile !== null) return { targetRelPath: targetFile, targetSymbolId: null };
  return null;
}

/**
 * True when a symbolId is a class-form method (uses `.` as the class↔method
 * separator). Mirrors the same predicate in `ruby-constant.ts` for the static
 * method resolution path shared by `resolveTypeStaticMethod` and
 * `RubyConstantSymbolResolutionStrategy`.
 */
export function symbolIdIsClassMethod(symbolId: string, member: string): boolean {
  if (symbolId === member) return true; // top-level function
  return symbolId.endsWith(`.${member}`);
}

/**
 * True when a symbolId is an instance-form method (uses `#` as the class↔method
 * separator). Used by `resolveTypeInstanceMethod` to exclude class methods when
 * both `Type.method` and `Type#method` exist in the symbol table.
 */
export function symbolIdIsInstanceMethod(symbolId: string, member: string): boolean {
  return symbolId.endsWith(`#${member}`);
}
