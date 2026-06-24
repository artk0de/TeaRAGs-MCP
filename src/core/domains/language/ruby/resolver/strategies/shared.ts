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
  type SymbolResolutionTarget,
} from "../../../../../contracts/types/codegraph.js";
import { ZEITWERK_PREFIX } from "../../walker/walker.js";
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
const EXTERNAL_CHAIN_TAILS = [
  ".headers",
  ".backtrace",
  ".constantize",
  ".deconstantize",
  ".to_param",
  ".class_name",
];

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
 * caller decides whether to prepend it. Used by the bare-call narrowing to walk
 * the MRO nearest-first when filtering ambiguous short-name candidates (brp1).
 *
 * Kept separate from `resolveInstanceMethodInClassChain`: that function
 * interleaves per-node file resolution + method lookup with a
 * method-pin-wins-immediately short-circuit, which a pre-flattened list cannot
 * express without losing the early return. This helper is the pure structural
 * traversal both the chain walk and the bareCall narrowing express the same
 * single ancestor order with.
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
 * Resolve `<member>` as an instance method on `klass`, walking `classAncestors`
 * (superclass + `include`/`extend` mixins) in declaration order when the class
 * itself doesn't own it. Shared by the `super` walk (which starts at the
 * ancestors) and the `self.<member>` walk (which starts at the enclosing class
 * itself) so both express the same Ruby MRO traversal once.
 *
 *   1. Resolve `klass` to its declaring file via `resolveConstant`.
 *   2. Within that file, look for `<member>` (short-name match scoped to the
 *      file). A unique candidate is a method-level edge.
 *   3. Miss → recurse into `classAncestors[klass]`, accumulating into `visited`
 *      so `A < B < A` cycles short-circuit. The first ancestor that owns
 *      `member` at the method level wins.
 *   4. File known but method absent anywhere in the chain → file-only edge
 *      (`targetSymbolId: null`) for the FIRST class whose file resolved, keeping
 *      file-level fan accurate for out-of-project parents (`ApplicationRecord`).
 *   5. No class in the chain resolves to a known file → `null` (caller DROPs).
 */
export function resolveInstanceMethodInClassChain(
  klass: string,
  member: string,
  ctx: CallContext,
  mode: AmbiguousResolveMode,
  visited: Set<string>,
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
      const inherited = resolveInstanceMethodInClassChain(prepended[i], member, ctx, mode, visited);
      if (inherited && inherited.targetSymbolId !== null) return inherited;
    }
  }

  const klassFile = resolveConstant(klass, ctx);
  let fileOnlyFallback: SymbolResolutionTarget | null =
    klassFile !== null ? { targetRelPath: klassFile, targetSymbolId: null } : null;

  if (klassFile !== null) {
    const candidates = ctx.symbolTable.lookupByShortName(member).filter((def) => def.relPath === klassFile);
    const target = pickSingleCandidate(candidates, mode);
    if (target) return { targetRelPath: target.relPath, targetSymbolId: target.symbolId };
  }

  const ancestors = ctx.classAncestors?.[klass];
  if (ancestors) {
    for (const ancestor of ancestors) {
      const inherited = resolveInstanceMethodInClassChain(ancestor, member, ctx, mode, visited);
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
 *   4. Miss → walk `classAncestors` in declaration order; the first ancestor that
 *      method-level-pins `<member>` wins.
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
  if (!targetFile) return null;

  const prepended = ctx.classPrependedAncestors?.[typeName];
  if (prepended) {
    for (let i = prepended.length - 1; i >= 0; i--) {
      const inherited = resolveTypeMethodInternal(prepended[i], member, ctx, mode, visited, symbolIdFilter);
      if (inherited && inherited.targetSymbolId !== null) return inherited;
    }
  }

  const bareType = lastConstantSegment(typeName);
  const candidates = ctx.symbolTable.lookupByShortName(member).filter((def) => {
    if (def.relPath !== targetFile) return false;
    const tail = def.scope[def.scope.length - 1];
    if (tail !== typeName && tail !== bareType) return false;
    return symbolIdFilter === null || symbolIdFilter(def.symbolId, member);
  });
  const target = pickSingleCandidate(candidates, mode);
  if (target) return { targetRelPath: target.relPath, targetSymbolId: target.symbolId };

  const ancestors = ctx.classAncestors?.[typeName];
  if (ancestors) {
    for (const ancestor of ancestors) {
      const inherited = resolveTypeMethodInternal(ancestor, member, ctx, mode, visited, symbolIdFilter);
      if (inherited && inherited.targetSymbolId !== null) return inherited;
    }
  }

  return { targetRelPath: targetFile, targetSymbolId: null };
}

/**
 * True when a symbolId is a class-form method (uses `.` as the class↔method
 * separator). Mirrors the same predicate in `ruby-constant.ts` for the static
 * method resolution path shared by `resolveTypeStaticMethod` and
 * `RubyConstantSymbolResolutionStrategy`.
 */
function symbolIdIsClassMethod(symbolId: string, member: string): boolean {
  if (symbolId === member) return true; // top-level function
  return symbolId.endsWith(`.${member}`);
}

/**
 * True when a symbolId is an instance-form method (uses `#` as the class↔method
 * separator). Used by `resolveTypeInstanceMethod` to exclude class methods when
 * both `Type.method` and `Type#method` exist in the symbol table.
 */
function symbolIdIsInstanceMethod(symbolId: string, member: string): boolean {
  return symbolId.endsWith(`#${member}`);
}
