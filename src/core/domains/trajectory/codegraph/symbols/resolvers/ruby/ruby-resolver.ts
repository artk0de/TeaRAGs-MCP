/**
 * Ruby implementation of the `CallResolver` contract.
 *
 * Two channels per the ruby-walker output:
 *
 *   1. Explicit `require`/`require_relative` — importText carries the
 *      string literal (with a "./" prefix for relative). Resolved by
 *      basename match (`require 'foo'` → any indexed `foo.rb`) or by
 *      filesystem-relative path (`require_relative './foo'` → sibling
 *      `foo.rb`).
 *
 *   2. Zeitwerk constant references — importText starts with the
 *      `zeitwerk:` prefix; the suffix is a fully-qualified constant
 *      chain. Resolved via `resolveZeitwerkConstant` over the symbol
 *      table's known file paths. The symbol table's `fileScope[]` from
 *      the ruby-walker holds the constants each file DEFINES, so a
 *      forward map `constant → file` is constructable; combined with
 *      the basename-and-root heuristic this covers ~95% of Rails-shape
 *      codebases without per-project config.
 */

import { posix } from "node:path";

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  pickSingleCandidate,
  type AmbiguousResolveMode,
  type CallContext,
  type CallRef,
  type CallResolver,
  type ResolvedTarget,
} from "../../../../../../contracts/types/codegraph.js";
import {
  SUPER_RECEIVER_SENTINEL,
  ZEITWERK_PREFIX,
} from "../../../../../ingest/pipeline/chunker/extraction/ruby-walker.js";
import { resolveZeitwerkConstant } from "./zeitwerk.js";

export class RubyCallResolver implements CallResolver {
  readonly language = "ruby";

  constructor(private readonly mode: AmbiguousResolveMode = DEFAULT_AMBIGUOUS_RESOLVE_MODE) {}

  resolve(call: CallRef, ctx: CallContext): ResolvedTarget | null {
    // `super` keyword (bd brp1). Walker emits a synthetic CallRef whose
    // receiver is SUPER_RECEIVER_SENTINEL and whose `member` is the
    // enclosing method's name — both decided at extraction time so the
    // resolver only needs to derive the parent class from `callerScope`.
    // The enclosing class is the last lexical scope segment; we join the
    // full chain with `::` to obtain the FQ key into `classAncestors`,
    // matching how `collectRubyClassAncestors` writes its keys. Reuses
    // `walkAncestorsForConstantCall` but in instance-method mode — a
    // bare `super` invokes the parent's SAME-named method as an instance
    // dispatch (singleton `def self.foo; super; end` also resolves
    // against the parent class's instance/class method as appropriate,
    // but the walker emits both shapes with `member` = bare method name
    // so the same ancestor walk handles both).
    if (call.receiver === SUPER_RECEIVER_SENTINEL) {
      return this.resolveSuper(call.member, ctx);
    }

    // Step 0: walker-inferred local type wins over heuristic resolution.
    // When the receiver maps to a known class via `var = ClassName.new`,
    // `var = Model.find(id)`, or YARD `@param var [Class]`, resolution
    // is constrained to that class — if the method isn't defined there,
    // the edge is dropped rather than guessed (which is the source of
    // false positives like `serializer.is_valid` resolving to user
    // classes that happen to define an `is_valid` method).
    if (call.receiver) {
      const localType = ctx.localBindings?.[call.receiver];
      if (localType) {
        return this.resolveByLocalType(localType, call.member, ctx);
      }
    }

    // Zeitwerk-style: receiver is a (possibly nested) constant chain.
    // The walker's `imports[]` already contains `zeitwerk:User`-shaped
    // entries; we re-derive from the receiver here so call sites
    // without a matching ImportRef (e.g. `User` referenced once and
    // used by multiple calls) still resolve. When the constant itself
    // doesn't own the method, walk its classAncestors chain — this is
    // the class-method form of the same inheritance fix used in Step 0.
    if (call.receiver && looksLikeConstant(call.receiver)) {
      const targetFile = this.resolveConstant(call.receiver, ctx);
      if (targetFile) {
        // Class.method call → prefer the `.`-form (class/static method)
        // over the `#`-form (instance method). A class can declare both
        // `def self.authorize!` and `def authorize!` — only the former
        // is reachable via `Klass.authorize!(...)`.
        const candidates = ctx.symbolTable
          .lookupByShortName(call.member)
          .filter((def) => def.relPath === targetFile && symbolIdIsClassMethod(def.symbolId, call.member));
        const target = pickSingleCandidate(candidates, this.mode);
        if (target) return { targetRelPath: target.relPath, targetSymbolId: target.symbolId };
        const inherited = this.walkAncestorsForConstantCall(call.receiver, call.member, ctx, new Set([call.receiver]));
        if (inherited) return inherited;
        return { targetRelPath: targetFile, targetSymbolId: null };
      }
    }

    // Explicit require: requireMatch fires ONLY when the receiver names the
    // import (i.e. `foo.bar` after `require 'foo'`, or `foo.bar` after
    // `require_relative './foo'`). Bare calls (`call.receiver === null`)
    // MUST NOT enter this branch — the bug jsa0 was a pair of always-true
    // predicates that absorbed every bare call into an arbitrary file edge,
    // blocking the t5iw same-class fallback below. Bare-call resolution
    // belongs in the global short-name fallback path which already gates on
    // language + scope.
    const requireMatch =
      call.receiver === null
        ? undefined
        : ctx.imports.find((imp) => {
            if (imp.importText.startsWith(ZEITWERK_PREFIX)) return false;
            if (imp.importText.startsWith("./")) {
              // require_relative — match when receiver text equals the
              // imported basename. Accept both the bare basename
              // (`foo.bar` after `require_relative './foo'` — the
              // typical case) and the literal importText (`./foo`) for
              // synthetic call sites.
              return call.receiver === imp.importText.slice(2) || call.receiver === imp.importText;
            }
            // bare `require 'foo'` — match when receiver text equals importText.
            return call.receiver === imp.importText;
          });

    if (requireMatch) {
      const targetFile = this.resolveExplicitRequire(requireMatch.importText, ctx.callerFile, this.knownPaths(ctx));
      if (targetFile) {
        const candidates = ctx.symbolTable.lookupByShortName(call.member).filter((def) => def.relPath === targetFile);
        const target = pickSingleCandidate(candidates, this.mode);
        if (target) return { targetRelPath: target.relPath, targetSymbolId: target.symbolId };
        return { targetRelPath: targetFile, targetSymbolId: null };
      }
    }

    // AR Relation chain guard: when the receiver text contains an
    // ActiveRecord query-builder method (`where`/`order`/`joins`/etc.)
    // the call is on an AR::Relation, not on a user-defined class.
    // Falling through to global short-name lookup would pick the
    // wrong target — `Product.ransack(form).result(distinct: true)`
    // historically mis-resolved to `AbstractPolicy#result`. Drop the
    // edge rather than guess.
    if (call.receiver && receiverLooksLikeArRelationChain(call.receiver)) {
      return null;
    }

    // Receiver-set drop guard (bd tea-rags-mcp-lttd). When a receiver is
    // set but every prior channel (local binding, Zeitwerk constant
    // lookup, explicit require) failed, the dynamic type is unknown.
    // Falling through to global short-name lookup fabricates false
    // positives — `serializer.is_valid` → unrelated `SomeForm#is_valid`,
    // `Regexp.escape(domain)` → `Rack::Protection::EscapedParams#escape`,
    // `agents.map(&:id)` → JS `d3.js#map`. Mirrors the Go / Java resolver
    // pattern (drop instead of guess). The bare-call branch below still
    // applies the global fallback because there's no receiver context to
    // narrow with.
    if (call.receiver !== null) {
      return null;
    }

    // Bare-call fallback: receiver is null, so global short-name lookup
    // is the only signal we have. Useful for top-level helpers and
    // Ruby's open-class additions to existing constants. Filter the
    // candidate list to ruby-language file paths so cross-language
    // index pollution (e.g. vendored JS / Java files under
    // `vendor/assets/javascripts/`) cannot surface as a Ruby edge — the
    // symbol table is language-agnostic (no `language` field on
    // SymbolDefinition), so we gate on the file extension. Bug pl7k.
    const fallback = ctx.symbolTable.lookupByShortName(call.member).filter((def) => isRubyPath(def.relPath));
    // Same-class scope preference (bug t5iw). When multiple short-name
    // candidates exist (e.g. `WebRequestConcern#user_agent` AND
    // `Agents::PhantomJsCloudAgent#user_agent`), strict-mode
    // pickSingleCandidate returns null and the edge drops silently.
    // Prefer candidates whose `scope[last]` matches the caller's
    // enclosing class — bare calls inside `Agents::PhantomJsCloudAgent`
    // should bind to that class's `user_agent` override, not be lost.
    // Mirrors the Java scope-filtered fallback (java-resolver.ts:50-54).
    // Ancestor-class preference is intentionally NOT applied here
    // (out-of-scope follow-up brp1) — only the direct enclosing class.
    if (fallback.length > 1 && ctx.callerScope.length > 0) {
      const enclosing = ctx.callerScope[ctx.callerScope.length - 1];
      const sameClass = fallback.filter((def) => def.scope[def.scope.length - 1] === enclosing);
      if (sameClass.length === 1) {
        return { targetRelPath: sameClass[0].relPath, targetSymbolId: sameClass[0].symbolId };
      }
    }
    const target = pickSingleCandidate(fallback, this.mode);
    if (target) return { targetRelPath: target.relPath, targetSymbolId: target.symbolId };
    return null;
  }

  /**
   * Look up `<typeName>.<member>` from the walker's local-binding
   * inference. Mirrors PythonCallResolver.resolveByLocalType.
   *
   * 1. Resolve `typeName` to a file via the symbol table (constant lookup
   *    falls through to Zeitwerk when uniqueness fails).
   * 2. Within that file, look for `<member>` as an instance method whose
   *    enclosing scope matches the class name.
   * 3. If the target file is identified but `<member>` is not in it,
   *    return a file-only edge so file-level fan stays accurate while
   *    dropping the method-level attribution (the method is inherited
   *    from a base class outside the project — common for AR `save`,
   *    `update`, etc. on `ApplicationRecord` subclasses).
   * 4. Return `null` only when the type's file is unknown.
   */
  private resolveByLocalType(typeName: string, member: string, ctx: CallContext): ResolvedTarget | null {
    return this.resolveByLocalTypeInternal(typeName, member, ctx, new Set());
  }

  /**
   * Inner recursion guarded against ancestor cycles (`A < B < A` shouldn't
   * be possible in Ruby but defensive — saves a stack overflow on malformed
   * extractions). `visited` carries the fully-qualified class names already
   * inspected so we don't re-check the same scope twice in a chain.
   */
  private resolveByLocalTypeInternal(
    typeName: string,
    member: string,
    ctx: CallContext,
    visited: Set<string>,
  ): ResolvedTarget | null {
    if (visited.has(typeName)) return null;
    visited.add(typeName);
    const targetFile = this.resolveConstant(typeName, ctx);
    if (!targetFile) return null;

    // bd tea-rags-mcp-3jvn — `prepend M` inserts M BEFORE the class itself
    // in Ruby's MRO. Instance-method lookup MUST check prepended modules
    // first, then the class, then regular ancestors (superclass + includes).
    // Source order is preserved by the walker; later `prepend` calls win
    // in MRO so we iterate the array in REVERSE here. Method-level pin is
    // required (`targetSymbolId !== null`) — a file-only fallback from a
    // prepended module is no better than the class's own file edge.
    const prepended = ctx.classPrependedAncestors?.[typeName];
    if (prepended) {
      for (let i = prepended.length - 1; i >= 0; i--) {
        const inherited = this.resolveByLocalTypeInternal(prepended[i], member, ctx, visited);
        if (inherited && inherited.targetSymbolId !== null) return inherited;
      }
    }

    // The walker emits the scope's last element as the FULL qualified
    // class name (`Product::IndexForm`) for nested-namespace classes,
    // and as the bare class name (`PaginatableForm`) for top-level
    // classes — both forms exist in the symbol table depending on how
    // the class header was declared. Accept either to cover both.
    const bareType = lastConstantSegment(typeName);
    const candidates = ctx.symbolTable.lookupByShortName(member).filter((def) => {
      if (def.relPath !== targetFile) return false;
      const tail = def.scope[def.scope.length - 1];
      return tail === typeName || tail === bareType;
    });
    const target = pickSingleCandidate(candidates, this.mode);
    if (target) return { targetRelPath: target.relPath, targetSymbolId: target.symbolId };

    // Method not found on this class — walk the ancestor chain
    // (`class Foo < Bar` superclass + `include Mod` / `extend Mod` mixins).
    // Walker emits these into FileExtraction.classAncestors and the
    // provider forwards via CallContext.classAncestors. Each ancestor is
    // tried in declaration order — the first that owns `member` wins.
    const ancestors = ctx.classAncestors?.[typeName];
    if (ancestors) {
      for (const ancestor of ancestors) {
        const inherited = this.resolveByLocalTypeInternal(ancestor, member, ctx, visited);
        // Only accept ancestor resolution when method-level pin succeeded —
        // a file-only fallback from the ancestor is no better than from
        // the bound class itself, so prefer the bound class's file edge.
        if (inherited && inherited.targetSymbolId !== null) return inherited;
      }
    }

    // File known but method not found in this class scope or its
    // ancestors — file-level attribution preserved, method-level dropped.
    return { targetRelPath: targetFile, targetSymbolId: null };
  }

  /**
   * Resolve a synthetic super-keyword CallRef (`receiver = "<super>"`).
   * The enclosing class is reconstructed from `callerScope` joined by
   * `::` (matching how `collectRubyClassAncestors` keys its map for
   * nested namespaces). The walk looks for an INSTANCE method with the
   * same `member` name on each ancestor in declaration order; the first
   * match wins. Class-form (`.`) candidates are accepted as a fallback
   * for singleton-method super calls (`def self.foo; super; end`).
   *
   * Returns null when:
   *   - `callerScope` is empty (super outside a class — shouldn't reach
   *     the resolver but defensively dropped),
   *   - the enclosing class has no `classAncestors` entry (no declared
   *     parent / mixins),
   *   - no ancestor resolves to a known file AND none defines `member`.
   *
   * A file-level edge with `targetSymbolId: null` is preferred over
   * `null` when an ancestor's file is known but the method isn't —
   * mirrors `resolveByLocalTypeInternal`'s behaviour so file-level
   * fan-in / fan-out stay accurate for out-of-project parents like
   * `ApplicationRecord` (whose `save` actually lives on
   * `ActiveRecord::Base` outside the index).
   */
  private resolveSuper(member: string, ctx: CallContext): ResolvedTarget | null {
    if (ctx.callerScope.length === 0) return null;
    // FQ key matches `collectRubyClassAncestors` output: nested classes
    // become `Outer::Inner` via scope-stack join with `::`.
    const enclosingClass = ctx.callerScope.join("::");
    const ancestors = ctx.classAncestors?.[enclosingClass];
    if (!ancestors) return null;
    const visited = new Set<string>([enclosingClass]);
    let fileOnlyFallback: ResolvedTarget | null = null;
    for (const ancestor of ancestors) {
      if (visited.has(ancestor)) continue;
      visited.add(ancestor);
      const ancestorFile = this.resolveConstant(ancestor, ctx);
      if (!ancestorFile) continue;
      // Prefer instance-form (`#`) for `super` — bare `super` inside
      // `def foo` dispatches to the parent's instance method. Accept
      // class-form (`.`) too because `def self.foo; super; end` uses
      // the same sentinel CallRef and resolves against the parent's
      // class method by the same short name.
      const candidates = ctx.symbolTable.lookupByShortName(member).filter((def) => def.relPath === ancestorFile);
      const target = pickSingleCandidate(candidates, this.mode);
      if (target) return { targetRelPath: target.relPath, targetSymbolId: target.symbolId };
      // Memo the first ancestor whose file is known so we can fall back
      // to a file-only edge if no ancestor has the method.
      if (fileOnlyFallback === null) {
        fileOnlyFallback = { targetRelPath: ancestorFile, targetSymbolId: null };
      }
      // Recurse one level deeper — multi-level inheritance (A < B < C)
      // where the method lives on C, not B. The deeper call carries the
      // already-visited set so cycles short-circuit.
      const deeper = this.resolveSuperRecurse(ancestor, member, ctx, visited);
      if (deeper && deeper.targetSymbolId !== null) return deeper;
    }
    return fileOnlyFallback;
  }

  /**
   * Inner recursion for {@link resolveSuper}. Walks `classAncestors`
   * starting at `klass`; `visited` is the cumulative set so deeper calls
   * can't re-enter a class already being inspected by the outer loop.
   */
  private resolveSuperRecurse(
    klass: string,
    member: string,
    ctx: CallContext,
    visited: Set<string>,
  ): ResolvedTarget | null {
    const ancestors = ctx.classAncestors?.[klass];
    if (!ancestors) return null;
    for (const ancestor of ancestors) {
      if (visited.has(ancestor)) continue;
      visited.add(ancestor);
      const ancestorFile = this.resolveConstant(ancestor, ctx);
      if (!ancestorFile) continue;
      const candidates = ctx.symbolTable.lookupByShortName(member).filter((def) => def.relPath === ancestorFile);
      const target = pickSingleCandidate(candidates, this.mode);
      if (target) return { targetRelPath: target.relPath, targetSymbolId: target.symbolId };
      const deeper = this.resolveSuperRecurse(ancestor, member, ctx, visited);
      if (deeper && deeper.targetSymbolId !== null) return deeper;
    }
    return null;
  }

  /**
   * Walk class ancestors for a Zeitwerk-style class-method call
   * (`Klass.method`). Mirrors the Step 0 inheritance walk but for the
   * Class.method dispatch surface — when ProductPolicy doesn't define
   * `authorize!` but inherits it from AbstractPolicy, the
   * ProductPolicy.authorize! call should land on AbstractPolicy.authorize!.
   * `visited` defends against ancestor cycles.
   */
  private walkAncestorsForConstantCall(
    receiver: string,
    member: string,
    ctx: CallContext,
    visited: Set<string>,
  ): ResolvedTarget | null {
    const ancestors = ctx.classAncestors?.[receiver];
    if (!ancestors) return null;
    for (const ancestor of ancestors) {
      if (visited.has(ancestor)) continue;
      visited.add(ancestor);
      const ancestorFile = this.resolveConstant(ancestor, ctx);
      if (!ancestorFile) continue;
      // Same Class.method preference as the outer Zeitwerk branch:
      // only consider class-form symbols (`Ancestor.method`), not
      // instance-form (`Ancestor#method`).
      const candidates = ctx.symbolTable
        .lookupByShortName(member)
        .filter((def) => def.relPath === ancestorFile && symbolIdIsClassMethod(def.symbolId, member));
      const target = pickSingleCandidate(candidates, this.mode);
      if (target) return { targetRelPath: target.relPath, targetSymbolId: target.symbolId };
      // Method not on this ancestor either — recurse one level deeper.
      const deeper = this.walkAncestorsForConstantCall(ancestor, member, ctx, visited);
      if (deeper && deeper.targetSymbolId !== null) return deeper;
    }
    return null;
  }

  private resolveConstant(qualified: string, ctx: CallContext): string | null {
    // Pass 1: look up the constant directly by qualified name in the
    // symbol table — every file's fileScope[] carries its declared
    // constants via the walker, so this works without conventions.
    const direct = ctx.symbolTable.lookup(qualified);
    if (direct.length === 1) return direct[0].relPath;
    // Pass 2: enclosing-scope walk (Ruby's Module.nesting). When a
    // bare constant is referenced from inside a (possibly nested)
    // class/module, Ruby walks the enclosing scopes outward looking
    // for `<scope>::<receiver>` before falling back to the top level.
    // Mirroring that here resolves nested classes referenced by short
    // name from a sibling method (bug ohz5). Only applies when the
    // receiver itself is unqualified — qualified chains already
    // specify the lookup root explicitly.
    if (!qualified.includes("::") && ctx.callerScope.length > 0) {
      for (let i = ctx.callerScope.length; i > 0; i--) {
        const prefix = ctx.callerScope.slice(0, i).join("::");
        const candidate = `${prefix}::${qualified}`;
        const matches = ctx.symbolTable.lookup(candidate);
        if (matches.length === 1) return matches[0].relPath;
      }
    }
    // Pass 3: Zeitwerk convention against known file paths.
    return resolveZeitwerkConstant(qualified, this.knownPaths(ctx));
  }

  private resolveExplicitRequire(importText: string, callerFile: string, knownPaths: Iterable<string>): string | null {
    if (importText.startsWith("./")) {
      // require_relative — resolve against caller's directory.
      const stripped = importText.slice(2);
      const withExt = stripped.endsWith(".rb") ? stripped : `${stripped}.rb`;
      const target = posix.normalize(posix.join(posix.dirname(callerFile), withExt));
      return target;
    }
    // Bare require — basename match across known paths.
    const wanted = importText.endsWith(".rb") ? importText : `${importText}.rb`;
    for (const p of knownPaths) {
      if (p === wanted) return p;
      if (p.endsWith(`/${wanted}`)) return p;
    }
    return null;
  }

  private knownPaths(ctx: CallContext): Iterable<string> {
    // The symbol table exposes definitions via lookupByShortName; we
    // derive the set of distinct relPaths from a single short-name
    // query is impractical here, so we reach into the table's known
    // paths indirectly: every imported module's name is itself a
    // candidate hint. For most projects the basename heuristic in
    // resolveZeitwerkConstant ranges over the file set populated via
    // the walker, which the symbol table backs anyway.
    const paths = new Set<string>();
    for (const imp of ctx.imports) {
      if (!imp.importText.startsWith(ZEITWERK_PREFIX)) paths.add(imp.importText);
    }
    // Add caller file so basename match has at least the local set.
    paths.add(ctx.callerFile);
    return paths;
  }
}

function looksLikeConstant(text: string): boolean {
  // Ruby constants begin with an uppercase letter. Scope_resolution
  // segments are joined by `::`. Both forms accepted.
  return /^[A-Z][A-Za-z0-9_]*(?:::[A-Z][A-Za-z0-9_]*)*$/.test(text);
}

/**
 * True when a symbolId is a class-form method (uses `.` as the
 * class↔method separator) rather than an instance-form (`#`). Used by
 * the Zeitwerk constant-receiver resolution path to prefer
 * `Klass.method` over `Klass#method` when both exist with the same
 * short name. Top-level functions (no `.` or `#` between class and
 * method) also match — they're callable as `name()` without a class
 * prefix, but `Module.function()` style top-level helpers fit the
 * `Class.method` shape and should resolve. The match is anchored on
 * the final segment `.<member>` to avoid colliding with namespace
 * separators like `Acme::Auth::Login.call`.
 */
function symbolIdIsClassMethod(symbolId: string, member: string): boolean {
  // Top-level function — no separator at all, symbolId === member.
  if (symbolId === member) return true;
  // Class.method or Acme::Klass.method — last `.` connects class to member.
  return symbolId.endsWith(`.${member}`);
}

function lastConstantSegment(qualified: string): string {
  const parts = qualified.split("::");
  return parts[parts.length - 1] ?? qualified;
}

/**
 * AR query-builder methods that return ActiveRecord::Relation. When the
 * receiver text of a call contains one of these as a `.method(` segment,
 * the receiver is a Relation rather than a user-defined class, and any
 * global short-name match would be a false positive. The list is the
 * conventional Rails AR API surface — narrow enough to avoid catching
 * unrelated methods named `where` / `order` on non-AR classes (those
 * trip when the receiver text is bare `obj.where`, but here we only
 * match the dot-prefixed chain form to keep the heuristic safe).
 */
const AR_RELATION_BUILDERS = [
  ".where(",
  ".order(",
  ".joins(",
  ".select(",
  ".group(",
  ".having(",
  ".includes(",
  ".eager_load(",
  ".preload(",
  ".limit(",
  ".offset(",
  ".distinct(",
  ".ransack(",
  ".unscope(",
  ".reorder(",
  ".except(",
  ".pluck(",
];

function receiverLooksLikeArRelationChain(receiver: string): boolean {
  for (const marker of AR_RELATION_BUILDERS) {
    if (receiver.includes(marker)) return true;
  }
  return false;
}

/**
 * Defense-in-depth filter for the bare-call global short-name fallback.
 * The symbol table is shared across languages — a Ruby resolver MUST
 * NOT attribute a call edge to a JavaScript / Java / etc. definition,
 * because the file extensions and call semantics don't match.
 *
 * `SymbolDefinition` has no `language` field today, so we gate on the
 * file extension (`.rb`, `.rake`, `.gemspec` — every file that the
 * tea-rags Ruby walker would have parsed). Vendored JS in
 * `vendor/assets/javascripts/*.js` is the canonical false-positive
 * source (huginn `agents.map(&:id)` → `d3.js#map`).
 */
function isRubyPath(relPath: string): boolean {
  return relPath.endsWith(".rb") || relPath.endsWith(".rake") || relPath.endsWith(".gemspec");
}
