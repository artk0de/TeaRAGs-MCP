import { CONTINUE, resolved } from "../../../../../contracts/resolution.js";
import {
  pickSingleCandidate,
  type CallContext,
  type CallRef,
  type SymbolResolutionTarget,
} from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { resolveConstant, type ResolverConfig } from "./shared.js";

/**
 * Zeitwerk-style: receiver is a (possibly nested) constant chain. The walker's
 * `imports[]` already contains `zeitwerk:User`-shaped entries; we re-derive from
 * the receiver here so call sites without a matching ImportRef (e.g. `User`
 * referenced once and used by multiple calls) still resolve. When the constant
 * itself doesn't own the method, walk its `classAncestors` chain — this is the
 * class-method form of the same inheritance fix used by the local-type pass.
 *
 * Continues (NOT drops) when the receiver doesn't look like a constant or the
 * constant can't be resolved to a file — later passes (explicit require,
 * AR-relation guard, receiver-set drop, bare-call fallback) still apply. Once a
 * constant file IS found this pass always resolves (a file-only edge counts).
 */
export class RubyConstantSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "constant";
  constructor(private readonly cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (!call.receiver || !looksLikeConstant(call.receiver)) return CONTINUE;
    const targetFile = resolveConstant(call.receiver, ctx);
    if (!targetFile) return CONTINUE;
    // Class.method call → prefer the `.`-form (class/static method)
    // over the `#`-form (instance method). A class can declare both
    // `def self.authorize!` and `def authorize!` — only the former
    // is reachable via `Klass.authorize!(...)`.
    const candidates = ctx.symbolTable
      .lookupByShortName(call.member)
      .filter((def) => def.relPath === targetFile && symbolIdIsClassMethod(def.symbolId, call.member));
    const target = pickSingleCandidate(candidates, this.cfg.mode);
    if (target) return resolved({ targetRelPath: target.relPath, targetSymbolId: target.symbolId });
    const inherited = this.walkAncestorsForConstantCall(call.receiver, call.member, ctx, new Set([call.receiver]));
    if (inherited) return resolved(inherited);
    return resolved({ targetRelPath: targetFile, targetSymbolId: null });
  }

  /**
   * Walk class ancestors for a Zeitwerk-style class-method call
   * (`Klass.method`). Mirrors the local-type inheritance walk but for the
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
  ): SymbolResolutionTarget | null {
    const ancestors = ctx.classAncestors?.[receiver];
    if (!ancestors) return null;
    for (const ancestor of ancestors) {
      if (visited.has(ancestor)) continue;
      visited.add(ancestor);
      const ancestorFile = resolveConstant(ancestor, ctx);
      if (!ancestorFile) continue;
      // Same Class.method preference as the outer Zeitwerk branch:
      // only consider class-form symbols (`Ancestor.method`), not
      // instance-form (`Ancestor#method`).
      const candidates = ctx.symbolTable
        .lookupByShortName(member)
        .filter((def) => def.relPath === ancestorFile && symbolIdIsClassMethod(def.symbolId, member));
      const target = pickSingleCandidate(candidates, this.cfg.mode);
      if (target) return { targetRelPath: target.relPath, targetSymbolId: target.symbolId };
      // Method not on this ancestor either — recurse one level deeper.
      const deeper = this.walkAncestorsForConstantCall(ancestor, member, ctx, visited);
      if (deeper && deeper.targetSymbolId !== null) return deeper;
    }
    return null;
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
