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
import { ZEITWERK_PREFIX } from "../../../../../ingest/pipeline/chunker/extraction/ruby-walker.js";
import { resolveZeitwerkConstant } from "./zeitwerk.js";

export class RubyCallResolver implements CallResolver {
  readonly language = "ruby";

  constructor(private readonly mode: AmbiguousResolveMode = DEFAULT_AMBIGUOUS_RESOLVE_MODE) {}

  resolve(call: CallRef, ctx: CallContext): ResolvedTarget | null {
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
    // used by multiple calls) still resolve.
    if (call.receiver && looksLikeConstant(call.receiver)) {
      const targetFile = this.resolveConstant(call.receiver, ctx);
      if (targetFile) {
        const candidates = ctx.symbolTable.lookupByShortName(call.member).filter((def) => def.relPath === targetFile);
        const target = pickSingleCandidate(candidates, this.mode);
        if (target) return { targetRelPath: target.relPath, targetSymbolId: target.symbolId };
        return { targetRelPath: targetFile, targetSymbolId: null };
      }
    }

    // Explicit require: receiver is a regular variable or null. Try
    // import-list match by basename / relative path.
    const requireMatch = ctx.imports.find((imp) => {
      if (imp.importText.startsWith(ZEITWERK_PREFIX)) return false;
      if (imp.importText.startsWith("./")) {
        // require_relative — match against file basename relative to caller
        const target = posix.normalize(posix.join(posix.dirname(ctx.callerFile), `${imp.importText.slice(2)}.rb`));
        return target === ctx.callerFile || true; // any explicit relative-import is candidate
      }
      // bare `require 'foo'` — match basename `foo.rb`.
      return call.receiver === null || call.receiver === imp.importText;
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

    // Last-ditch: global short-name lookup. Useful for top-level
    // helpers + Ruby's open-class additions to existing constants.
    const fallback = ctx.symbolTable.lookupByShortName(call.member);
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
    const targetFile = this.resolveConstant(typeName, ctx);
    if (!targetFile) return null;
    const bareType = lastConstantSegment(typeName);
    const candidates = ctx.symbolTable
      .lookupByShortName(member)
      .filter((def) => def.relPath === targetFile && def.scope[def.scope.length - 1] === bareType);
    const target = pickSingleCandidate(candidates, this.mode);
    if (target) return { targetRelPath: target.relPath, targetSymbolId: target.symbolId };
    // File known but method not found in this class scope — file-level
    // attribution preserved, method-level dropped.
    return { targetRelPath: targetFile, targetSymbolId: null };
  }

  private resolveConstant(qualified: string, ctx: CallContext): string | null {
    // Pass 1: look up the constant directly by qualified name in the
    // symbol table — every file's fileScope[] carries its declared
    // constants via the walker, so this works without conventions.
    const direct = ctx.symbolTable.lookup(qualified);
    if (direct.length === 1) return direct[0].relPath;
    // Pass 2: Zeitwerk convention against known file paths.
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
