/**
 * Shared inputs and helpers for the Swift symbol-resolution strategies.
 *
 * `SwiftResolverConfig` is the per-resolver config every strategy receives by
 * constructor injection (the `SwiftCallResolver(mode)` argument). The helpers
 * below are the lookups more than one strategy shares, factored here so each
 * lives once — and so every one of them goes through the Swift-filtered table
 * entry points rather than the polyglot table
 * (`.claude/rules/resolver-architecture.md` §2).
 *
 * The name is domain-qualified rather than the bare `ResolverConfig` the Java
 * and Rust strategy barrels export: three identically-named exports would each
 * need their neighbours to disambiguate at an import line
 * (`.claude/rules/naming.md`).
 */

import { DROP, resolved } from "../../../../../contracts/resolution.js";
import {
  pickSingleCandidate,
  type AmbiguousResolveMode,
  type CallContext,
  type SymbolResolutionTarget,
} from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome } from "../../../../../contracts/types/language.js";
import { lookupSwiftSymbols } from "../swift-symbol-lookup.js";

export interface SwiftResolverConfig {
  mode: AmbiguousResolveMode;
}

/**
 * Receivers that name no value and must never be read as a property or a local:
 * `self` / `Self` are the enclosing instance and type, `super` is the
 * supertype. Each is claimed (or deliberately declined) by a pass of its own.
 */
export const SWIFT_PSEUDO_RECEIVERS: ReadonlySet<string> = new Set(["self", "Self", "super"]);

/**
 * Resolve `<typeName>#<member>` (instance) then `<typeName>.<member>` (static /
 * class) over Swift declarations. Instance first because Swift's type members
 * are overwhelmingly instance-level and a static namesake is the rarer shape.
 */
export function lookupSwiftTypeMember(
  typeName: string,
  member: string,
  ctx: CallContext,
  mode: AmbiguousResolveMode,
): SymbolResolutionTarget | null {
  const instanceHit = pickSingleCandidate(lookupSwiftSymbols(ctx, `${typeName}#${member}`), mode);
  if (instanceHit) return { targetRelPath: instanceHit.relPath, targetSymbolId: instanceHit.symbolId };
  const staticHit = pickSingleCandidate(lookupSwiftSymbols(ctx, `${typeName}.${member}`), mode);
  if (staticHit) return { targetRelPath: staticHit.relPath, targetSymbolId: staticHit.symbolId };
  return null;
}

/**
 * A receiver whose type the walker PROVED (a typed parameter, an annotated
 * `let`, a stored property) resolves against that type or emits nothing.
 *
 * Java's equivalent (`resolveByLocalType`) falls back to a type-qualified
 * best-effort target for a receiver whose type is not a project symbol, which
 * records a JDK dependency without naming a file. Swift deliberately does NOT:
 * its bound receivers are dominated by `String` / `Int` / `Array` / `URL` and
 * the standard library is far larger a share of the surface than `java.lang`
 * is, so that fallback would fill the graph with synthetic non-project nodes
 * carrying no file anyone can navigate to. Instead the miss DROPS — the bound
 * type is authoritative, so a member it does not declare must not fall through
 * to a pass that would pin it to an unrelated type's namesake (Rust's
 * `selfField` verdict, bd tea-rags-mcp-q1pl).
 */
export function resolveSwiftBoundTypeMember(
  typeName: string,
  member: string,
  ctx: CallContext,
  mode: AmbiguousResolveMode,
): SymbolResolutionOutcome {
  const hit = lookupSwiftTypeMember(typeName, member, ctx, mode);
  return hit ? resolved(hit) : DROP;
}

/**
 * Look up `<enclosingType>#<member>` / `<enclosingType>.<member>` constrained to
 * the caller's OWN file — the same-file arm the `self.` and bare-call passes
 * share. A hit here outranks anything the project-wide passes could say,
 * because a type's method declared in the very file that calls it is not a
 * guess.
 *
 * Returns null when the caller has no enclosing type (a top-level function) or
 * neither form is declared in the file; the caller then continues down the
 * chain to the extension-scope pass, which is where a Swift type split across
 * files is answered.
 */
export function lookupEnclosingTypeMemberInFile(member: string, ctx: CallContext): SymbolResolutionTarget | null {
  const enclosing = ctx.callerScope[ctx.callerScope.length - 1];
  if (!enclosing) return null;
  const instanceHit = lookupSwiftSymbols(ctx, `${enclosing}#${member}`).find((def) => def.relPath === ctx.callerFile);
  if (instanceHit) return { targetRelPath: instanceHit.relPath, targetSymbolId: instanceHit.symbolId };
  const staticHit = lookupSwiftSymbols(ctx, `${enclosing}.${member}`).find((def) => def.relPath === ctx.callerFile);
  if (staticHit) return { targetRelPath: staticHit.relPath, targetSymbolId: staticHit.symbolId };
  return null;
}
