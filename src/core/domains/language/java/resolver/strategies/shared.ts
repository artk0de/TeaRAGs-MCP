/**
 * Shared inputs and helpers for the Java symbol-resolution strategies.
 *
 * `ResolverConfig` is the per-resolver config every strategy receives by
 * constructor injection (the old `JavaCallResolver(mode)` argument).
 * `resolveByLocalType` and `lookupEnclosingMember` are the two helpers more than
 * one strategy shares — factored here so each lives once (the field-type AND
 * local-binding passes both resolve a known receiver type; the this-member AND
 * implicit-receiver bare-call passes both look up the enclosing class member).
 */

import {
  pickSingleCandidate,
  type AmbiguousResolveMode,
  type CallContext,
  type SymbolResolutionTarget,
} from "../../../../../contracts/types/codegraph.js";

export interface ResolverConfig {
  mode: AmbiguousResolveMode;
}

/**
 * bd tea-rags-mcp-cvv9 — resolve a typed-receiver call where the receiver was
 * bound to `typeName` (a method parameter / local var / `this.field` type).
 * Strategy:
 *
 *   1. Symbol-table first — try `typeName#member` (instance) then
 *      `typeName.member` (static). A unique candidate wins → real edge.
 *   2. External type — when the type is NOT a project symbol (JDK interfaces
 *      like `CharSequence`, third-party classes), the method cannot be pinned to
 *      a file but the receiver type IS known. Emit the type-qualified
 *      best-effort target `typeName#member` anchored to the bare type name as
 *      `targetRelPath`. This records the type-qualified dependency without
 *      fabricating a wrong `.java` file — the resolver already records
 *      type-qualified / file-only targets for receivers whose method isn't in
 *      the table.
 *
 * Never falls through to the ambiguous short-name path — the bound type is
 * authoritative, so a method that doesn't match still routes to that type
 * (instance form) rather than a same-class false positive. Returns a target
 * UNCONDITIONALLY (`SymbolResolutionTarget`, not `| null`).
 */
export function resolveByLocalType(
  typeName: string,
  member: string,
  ctx: CallContext,
  mode: AmbiguousResolveMode,
): SymbolResolutionTarget {
  const instanceCandidates = ctx.symbolTable.lookup(`${typeName}#${member}`);
  const instanceHit = pickSingleCandidate(instanceCandidates, mode);
  if (instanceHit) return { targetRelPath: instanceHit.relPath, targetSymbolId: instanceHit.symbolId };
  const staticCandidates = ctx.symbolTable.lookup(`${typeName}.${member}`);
  const staticHit = pickSingleCandidate(staticCandidates, mode);
  if (staticHit) return { targetRelPath: staticHit.relPath, targetSymbolId: staticHit.symbolId };
  // External / not-yet-indexed type — record the type-qualified target.
  return { targetRelPath: typeName, targetSymbolId: `${typeName}#${member}` };
}

/**
 * bd tea-rags-mcp-9t8z — look up `<enclosingClass>#<member>` (instance) then
 * `<enclosingClass>.<member>` (static) constrained to the caller's own file.
 * Mirrors `TSCallResolver`'s same-file enclosing lookup so Java agrees on
 * intra-class dispatch.
 *
 * Returns the resolved target or null when neither form is present — the caller
 * then falls through to import / global resolution.
 */
export function lookupEnclosingMember(member: string, ctx: CallContext): SymbolResolutionTarget | null {
  const enclosing = ctx.callerScope[ctx.callerScope.length - 1];
  const instanceFq = `${enclosing}#${member}`;
  const instanceHit = ctx.symbolTable.lookup(instanceFq).find((def) => def.relPath === ctx.callerFile);
  if (instanceHit) return { targetRelPath: instanceHit.relPath, targetSymbolId: instanceHit.symbolId };
  const staticFq = `${enclosing}.${member}`;
  const staticHit = ctx.symbolTable.lookup(staticFq).find((def) => def.relPath === ctx.callerFile);
  if (staticHit) return { targetRelPath: staticHit.relPath, targetSymbolId: staticHit.symbolId };
  return null;
}
