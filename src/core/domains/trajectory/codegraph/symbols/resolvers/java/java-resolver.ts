/**
 * Java implementation of the `CallResolver` contract.
 *
 * Java imports name fully-qualified types: `com.foo.Bar` →
 * `com/foo/Bar.java`. Wildcard imports (`com.foo.*`) point at a
 * package (directory) rather than a single file, so resolution
 * relies on the symbol table's short-name lookup restricted to that
 * directory.
 */

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  pickSingleCandidate,
  type AmbiguousResolveMode,
  type CallContext,
  type CallRef,
  type CallResolver,
  type ResolvedTarget,
} from "../../../../../../contracts/types/codegraph.js";

export class JavaCallResolver implements CallResolver {
  readonly language = "java";

  constructor(private readonly mode: AmbiguousResolveMode = DEFAULT_AMBIGUOUS_RESOLVE_MODE) {}

  resolve(call: CallRef, ctx: CallContext): ResolvedTarget | null {
    // bd tea-rags-mcp-9t8z — `this.X()` intra-class call. Resolve to
    // `<enclosingClass>#X` (instance) or `<enclosingClass>.X` (static)
    // constrained to the caller's own file before falling through to
    // import / global short-name resolution. Mirrors the TS resolver's
    // `this.X()` branch — without this an explicit `this.helper()` was
    // treated as receiver "this" and dropped (no import matches "this",
    // scope-filter rejects every candidate).
    if (call.receiver === "this" && ctx.callerScope.length > 0) {
      const sameFileHit = this.lookupEnclosingMember(call.member, ctx);
      if (sameFileHit) return sameFileHit;
    }
    // bd tea-rags-mcp-cvv9 — `this.<field>.<method>()`. Read the field's
    // declared type from `classFieldTypes[enclosingClass]` and resolve the
    // method against that type. Mirrors the TS resolver's field-access
    // branch. Only ONE level of access (`this.foo.bar()`) — a deeper chain
    // (`this.foo.bar.baz()`) carries no single type and falls through to
    // the existing drop. Consulted BEFORE the import-receiver pass so a
    // known field type wins over ambiguous short-name resolution.
    if (call.receiver && call.receiver.startsWith("this.") && ctx.callerScope.length > 0) {
      const fieldSegment = call.receiver.slice("this.".length);
      if (!fieldSegment.includes(".")) {
        const enclosing = ctx.callerScope[ctx.callerScope.length - 1];
        const typeName = ctx.classFieldTypes?.[enclosing]?.[fieldSegment];
        if (typeName) return this.resolveByLocalType(typeName, call.member, ctx);
      }
    }
    // bd tea-rags-mcp-cvv9 — typed-receiver call (`param.method()` /
    // `localVar.method()`) where the walker bound `receiver` to a type in
    // `ctx.localBindings`. Resolve `<Type>#member` / `<Type>.member`.
    // Consulted BEFORE the import-receiver pass and the ambiguous
    // short-name fallback so an unambiguous local type wins instead of the
    // call being dropped (e.g. `cs.charAt(i)` where `cs: CharSequence`).
    if (call.receiver) {
      const boundType = ctx.localBindings?.[call.receiver];
      if (boundType) return this.resolveByLocalType(boundType, call.member, ctx);
    }
    if (call.receiver) {
      const match = ctx.imports.find((imp) => javaImportMatchesReceiver(imp.importText, call.receiver as string));
      if (match) {
        const targetFile = mapJavaImportToFile(match.importText);
        if (targetFile) {
          const candidates = ctx.symbolTable
            .lookupByShortName(call.member)
            .filter((def) => def.relPath === targetFile || def.relPath.endsWith(`/${targetFile}`));
          const target = pickSingleCandidate(candidates, this.mode);
          if (target) return { targetRelPath: target.relPath, targetSymbolId: target.symbolId };
          return { targetRelPath: targetFile, targetSymbolId: null };
        }
      }
      // No import matched. Salvage one safe case: wildcard imports
      // (`import com.foo.*`) bring all classes from a package into scope
      // without a per-class import line. We can still resolve
      // `Bar.method()` IF some candidate's owning class name equals the
      // receiver. This filter also rejects the false-positive cases that
      // motivated the bug: `Character.isWhitespace` against
      // `StringUtils.isWhitespace` (scope=[StringUtils] != "Character"),
      // `cs.charAt` against `StrBuilder#charAt`
      // (scope=[StrBuilder] != "cs"), `random().nextBytes()` against
      // `RandomUtils.nextBytes` (scope=[RandomUtils] != "random()").
      const filteredByScope = ctx.symbolTable
        .lookupByShortName(call.member)
        .filter((def) => def.scope[def.scope.length - 1] === call.receiver);
      const target = pickSingleCandidate(filteredByScope, this.mode);
      if (target) return { targetRelPath: target.relPath, targetSymbolId: target.symbolId };
      return null;
    }
    // bd tea-rags-mcp-9t8z — implicit-receiver bare call (Java `foo()`
    // inside a class body is shorthand for `this.foo()` for instance
    // methods, or a private/static helper of the enclosing class). Try
    // the same enclosing-class lookup FIRST so a global short-name
    // collision (e.g. `append` on both HashCodeBuilder and StringBuffer)
    // doesn't drop the edge or misroute it.
    if (ctx.callerScope.length > 0) {
      const sameFileHit = this.lookupEnclosingMember(call.member, ctx);
      if (sameFileHit) return sameFileHit;
    }
    const fallback = ctx.symbolTable.lookupByShortName(call.member);
    const target = pickSingleCandidate(fallback, this.mode);
    if (target) return { targetRelPath: target.relPath, targetSymbolId: target.symbolId };
    return null;
  }

  /**
   * bd tea-rags-mcp-cvv9 — resolve a typed-receiver call where the
   * receiver was bound to `typeName` (a method parameter / local var /
   * `this.field` type). Strategy:
   *
   *   1. Symbol-table first — try `typeName#member` (instance) then
   *      `typeName.member` (static). A unique candidate wins → real edge.
   *   2. External type — when the type is NOT a project symbol (JDK
   *      interfaces like `CharSequence`, third-party classes), the method
   *      cannot be pinned to a file but the receiver type IS known. Emit
   *      the type-qualified best-effort target `typeName#member` anchored
   *      to the bare type name as `targetRelPath`. This records the
   *      type-qualified dependency without fabricating a wrong `.java`
   *      file — the resolver already records type-qualified / file-only
   *      targets for receivers whose method isn't in the table.
   *
   * Never falls through to the ambiguous short-name path — the bound type
   * is authoritative, so a method that doesn't match still routes to that
   * type (instance form) rather than a same-class false positive.
   */
  private resolveByLocalType(typeName: string, member: string, ctx: CallContext): ResolvedTarget {
    const instanceCandidates = ctx.symbolTable.lookup(`${typeName}#${member}`);
    const instanceHit = pickSingleCandidate(instanceCandidates, this.mode);
    if (instanceHit) return { targetRelPath: instanceHit.relPath, targetSymbolId: instanceHit.symbolId };
    const staticCandidates = ctx.symbolTable.lookup(`${typeName}.${member}`);
    const staticHit = pickSingleCandidate(staticCandidates, this.mode);
    if (staticHit) return { targetRelPath: staticHit.relPath, targetSymbolId: staticHit.symbolId };
    // External / not-yet-indexed type — record the type-qualified target.
    return { targetRelPath: typeName, targetSymbolId: `${typeName}#${member}` };
  }

  /**
   * bd tea-rags-mcp-9t8z — look up `<enclosingClass>#<member>` (instance)
   * then `<enclosingClass>.<member>` (static) constrained to the
   * caller's own file. Mirrors `TSCallResolver`'s same-file enclosing
   * lookup so Java agrees on intra-class dispatch.
   *
   * Returns the resolved target or null when neither form is present
   * — the caller then falls through to import / global resolution.
   */
  private lookupEnclosingMember(member: string, ctx: CallContext): ResolvedTarget | null {
    const enclosing = ctx.callerScope[ctx.callerScope.length - 1];
    const instanceFq = `${enclosing}#${member}`;
    const instanceHit = ctx.symbolTable.lookup(instanceFq).find((def) => def.relPath === ctx.callerFile);
    if (instanceHit) return { targetRelPath: instanceHit.relPath, targetSymbolId: instanceHit.symbolId };
    const staticFq = `${enclosing}.${member}`;
    const staticHit = ctx.symbolTable.lookup(staticFq).find((def) => def.relPath === ctx.callerFile);
    if (staticHit) return { targetRelPath: staticHit.relPath, targetSymbolId: staticHit.symbolId };
    return null;
  }
}

export function mapJavaImportToFile(importText: string): string | null {
  // Strip wildcards — they point at directories, not specific files.
  if (importText.endsWith(".*")) return null;
  // Static import: drop trailing `.methodName` (the part after the
  // last segment whose first letter is uppercase signifies the class).
  const segments = importText.split(".");
  // Find the class segment (first uppercase-leading segment).
  let classIdx = -1;
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i] ?? "";
    if (s.length > 0 && s[0] >= "A" && s[0] <= "Z") {
      classIdx = i;
      break;
    }
  }
  if (classIdx === -1) return null;
  const pathSegments = segments.slice(0, classIdx + 1);
  return `${pathSegments.join("/")}.java`;
}

function javaImportMatchesReceiver(importText: string, receiver: string): boolean {
  // Wildcard imports — receiver might match any class in that package
  // but we can't pin a specific one here. Reject so caller falls
  // through to global lookup.
  if (importText.endsWith(".*")) return false;
  const segments = importText.split(".");
  const last = segments[segments.length - 1] ?? "";
  return last === receiver;
}
