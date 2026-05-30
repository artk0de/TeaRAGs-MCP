import {
  pickSingleCandidate,
  type CallContext,
  type CallRef,
  type SymbolResolutionTarget,
} from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { CONTINUE, DROP, resolved } from "../../../../../contracts/resolution.js";
import { resolveConstant, type ResolverConfig } from "./shared.js";

/**
 * Walker-inferred local type wins over heuristic resolution. When the receiver
 * maps to a known class via `var = ClassName.new`, `var = Model.find(id)`, or
 * YARD `@param var [Class]`, resolution is constrained to that class — if the
 * method isn't defined there, the edge is DROPPED rather than guessed (which is
 * the source of false positives like `serializer.is_valid` resolving to user
 * classes that happen to define an `is_valid` method).
 *
 * This is a **guard** strategy for any receiver carrying a local binding: once
 * the binding exists the call is terminal — it resolves (a file-only edge still
 * counts as resolved when the type's file is known but the method isn't), or it
 * drops when the type's file is entirely unknown. It never falls through to the
 * later heuristic passes, mirroring the original orchestrator's `return`.
 */
export class RubyLocalTypeSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "localType";
  constructor(private readonly cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (!call.receiver) return CONTINUE;
    const localType = ctx.localBindings?.[call.receiver];
    if (!localType) return CONTINUE;
    const target = this.resolveByLocalType(localType, call.member, ctx);
    // Once a local binding exists the call is terminal — a miss (the type's
    // file is unknown) DROPS rather than falling through to a heuristic pass.
    return target ? resolved(target) : DROP;
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
  private resolveByLocalType(typeName: string, member: string, ctx: CallContext): SymbolResolutionTarget | null {
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
  ): SymbolResolutionTarget | null {
    if (visited.has(typeName)) return null;
    visited.add(typeName);
    const targetFile = resolveConstant(typeName, ctx);
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
    const target = pickSingleCandidate(candidates, this.cfg.mode);
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
}

function lastConstantSegment(qualified: string): string {
  const parts = qualified.split("::");
  return parts[parts.length - 1] ?? qualified;
}
