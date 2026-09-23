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
import type { SwiftMemberTypeLookup } from "../swift-member-type-lookup.js";
import { lookupSwiftSymbols } from "../swift-symbol-lookup.js";
import { isSwiftTypeName } from "../swift-type-name.js";

export interface SwiftResolverConfig {
  mode: AmbiguousResolveMode;
  /**
   * The resolver's ONE member-type lookup
   * (`../swift-member-type-lookup.ts`), shared by every pass that types a
   * receiver. Injected rather than constructed per strategy because its memos
   * are per-RUN state: a second instance would rebuild the run's field union
   * and its ancestor linearizers, and `chainedReceiverType` and
   * `storedPropertyType` would answer the same `self.<x>` off two different
   * folds.
   */
  memberTypes: SwiftMemberTypeLookup;
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
 * The TYPES lexically enclosing the caller, innermost first, each as the
 * qualified id its members compose under (bd tea-rags-mcp-3ievc).
 *
 * `callerScope` is the chain of NAMES a declaration sits in — `["Outer",
 * "Inner"]` for a method of a nested type, `["Store", "run"]` for a local
 * function inside `Store#run` — while the members of `Inner` compose as
 * `Outer.Inner#m`. So the enclosing type is never the bare last segment: it is
 * the scope PREFIX, joined with Swift's `.` separator, and only at a depth whose
 * segment names a TYPE. A function segment is skipped, which is what lets a
 * local function (or a closure inside one) reach its type's members — Swift
 * captures `self` there. The type test is the UpperCamelCase guideline this
 * vertical already spends as evidence (`../swift-type-name.ts`); a dotted
 * segment — `extension AFError.Reason` — is judged by its last component.
 */
export function swiftEnclosingTypeIds(ctx: CallContext): string[] {
  const out: string[] = [];
  for (let depth = ctx.callerScope.length; depth > 0; depth--) {
    if (!isTypeSegment(ctx.callerScope[depth - 1])) continue;
    out.push(ctx.callerScope.slice(0, depth).join("."));
  }
  return out;
}

/**
 * The innermost enclosing TYPE's own scope segment — what `self` denotes,
 * spelled the way the walker keys `classFieldTypes` and `classExtends` (the
 * declaration's name text, so `Inner` for a nested type and `AFError.Reason`
 * for an extension of one). Undefined at file scope. Skips function segments
 * for the reason {@link swiftEnclosingTypeIds} states.
 */
export function swiftSelfTypeName(ctx: CallContext): string | undefined {
  for (let depth = ctx.callerScope.length; depth > 0; depth--) {
    const segment = ctx.callerScope[depth - 1];
    if (isTypeSegment(segment)) return segment;
  }
  return undefined;
}

/** Whether a scope segment names a type — judged by its last `.` component. */
function isTypeSegment(segment: string): boolean {
  return isSwiftTypeName(segment.slice(segment.lastIndexOf(".") + 1));
}

/** Look up `<typeId>#<member>` then `<typeId>.<member>`, constrained to the caller's OWN file. */
function lookupTypeMemberInCallerFile(typeId: string, member: string, ctx: CallContext): SymbolResolutionTarget | null {
  const instanceHit = lookupSwiftSymbols(ctx, `${typeId}#${member}`).find((def) => def.relPath === ctx.callerFile);
  if (instanceHit) return { targetRelPath: instanceHit.relPath, targetSymbolId: instanceHit.symbolId };
  const staticHit = lookupSwiftSymbols(ctx, `${typeId}.${member}`).find((def) => def.relPath === ctx.callerFile);
  if (staticHit) return { targetRelPath: staticHit.relPath, targetSymbolId: staticHit.symbolId };
  return null;
}

/**
 * The same-file arm of `self.member()` / `Self.member()`: the member of the
 * INNERMOST enclosing type, and only that one. A hit here outranks anything the
 * project-wide passes could say, because a type's method declared in the very
 * file that calls it is not a guess.
 *
 * Deliberately not the outward walk {@link lookupLexicalMemberInFile} does:
 * `self` inside a nested type is the NESTED type, and Swift gives it no
 * implicit reference to an outer instance.
 *
 * Returns null when the caller has no enclosing type (a top-level function) or
 * neither form is declared in the file; the caller then continues down the
 * chain to the extension-scope pass, which is where a Swift type split across
 * files is answered.
 */
export function lookupSelfTypeMemberInFile(member: string, ctx: CallContext): SymbolResolutionTarget | null {
  const selfType = swiftEnclosingTypeIds(ctx)[0];
  return selfType === undefined ? null : lookupTypeMemberInCallerFile(selfType, member, ctx);
}

/**
 * The same-file arm of a BARE call: Swift's unqualified lookup, which searches
 * the members of each enclosing type from the innermost outward and stops at
 * the first that declares the name. So an inner declaration shadows an outer
 * one, and a nested type's body still reaches a sibling nested type or its own
 * enclosing type's static members — `Options(rawValue:)` written inside
 * `Download.Options` names `Download.Options`, found one scope out.
 */
export function lookupLexicalMemberInFile(member: string, ctx: CallContext): SymbolResolutionTarget | null {
  for (const typeId of swiftEnclosingTypeIds(ctx)) {
    const hit = lookupTypeMemberInCallerFile(typeId, member, ctx);
    if (hit) return hit;
  }
  return null;
}
