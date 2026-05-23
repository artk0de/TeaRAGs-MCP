/**
 * Rust implementation of the `CallResolver` contract.
 *
 * Rust paths use `::` separators with prefixes:
 *   - `crate::` — current crate root
 *   - `super::` — parent module
 *   - `self::` — current module
 *   - bare paths — refer to a use'd import or external crate
 *
 * Without project-level Cargo metadata we resolve by basename match
 * over the symbol table — for `use crate::foo::bar`, look up `bar`
 * and accept any file whose path ends in `foo/bar.rs` (or
 * `foo/bar/mod.rs`). External crates are out of scope.
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

export class RustCallResolver implements CallResolver {
  readonly language = "rust";

  constructor(private readonly mode: AmbiguousResolveMode = DEFAULT_AMBIGUOUS_RESOLVE_MODE) {}

  resolve(call: CallRef, ctx: CallContext): ResolvedTarget | null {
    // bd tea-rags-mcp-c5by — `self.method()` intra-impl call. Resolve to
    // `<enclosingType>#method` (instance) or `<enclosingType>.method`
    // (associated function) constrained to the caller's own file before
    // falling through to import / global short-name resolution. Mirrors
    // the Java resolver's `this.X()` branch — without this, `self.clone()`
    // grabs the FIRST `clone` from the symbol table (e.g. `Error#clone`)
    // and produces cross-receiver garbage edges.
    if (call.receiver === "self" && ctx.callerScope.length > 0) {
      const sameFileHit = this.lookupEnclosingMember(call.member, ctx);
      if (sameFileHit) return sameFileHit;
    }
    if (call.receiver) {
      // bd tea-rags-mcp-c5by — when localBindings type-binds the receiver
      // to a known class, resolve against THAT type's members first AND
      // drop the global short-name fallback when the type lacks the
      // member. Prevents `obj.clone()` (obj: Worker) silently routing to
      // `Error#clone`. Mirrors Java 9t8z / Go e6xx "drop unsafe short-name
      // fallback when receiver type known but member missing".
      const boundType = ctx.localBindings?.[call.receiver];
      if (boundType) {
        const instanceFq = `${boundType}#${call.member}`;
        const instanceHit = pickSingleCandidate(ctx.symbolTable.lookup(instanceFq), this.mode);
        if (instanceHit) return { targetRelPath: instanceHit.relPath, targetSymbolId: instanceHit.symbolId };
        const staticFq = `${boundType}.${call.member}`;
        const staticHit = pickSingleCandidate(ctx.symbolTable.lookup(staticFq), this.mode);
        if (staticHit) return { targetRelPath: staticHit.relPath, targetSymbolId: staticHit.symbolId };
        // Receiver type known but member not on it — DROP the edge.
        // Falling through to short-name lookup would resolve to a method
        // on an unrelated type, which is the c5by garbage.
        return null;
      }
      const match = ctx.imports.find((imp) => rustImportMatchesReceiver(imp.importText, call.receiver as string));
      if (match) {
        const suffix = rustImportSuffix(match.importText);
        if (suffix) {
          const candidates = ctx.symbolTable
            .lookupByShortName(call.member)
            .filter((def) => def.relPath.endsWith(`${suffix}.rs`) || def.relPath.endsWith(`${suffix}/mod.rs`));
          const target = pickSingleCandidate(candidates, this.mode);
          if (target) return { targetRelPath: target.relPath, targetSymbolId: target.symbolId };
        }
      }
    }
    // bd tea-rags-mcp-c5by — bare `helper()` inside an impl block is
    // shorthand for `self.helper()` (instance) or an associated function
    // of the enclosing type. Probe the enclosing-type lookup FIRST so a
    // global collision (e.g. `helper` on both Worker and Other) doesn't
    // misroute. Mirrors java-resolver's bare-call branch.
    if (call.receiver === null && ctx.callerScope.length > 0) {
      const sameFileHit = this.lookupEnclosingMember(call.member, ctx);
      if (sameFileHit) return sameFileHit;
    }
    const fallback = ctx.symbolTable.lookupByShortName(call.member);
    const target = pickSingleCandidate(fallback, this.mode);
    if (target) return { targetRelPath: target.relPath, targetSymbolId: target.symbolId };
    return null;
  }

  /**
   * bd tea-rags-mcp-c5by — look up `<enclosingType>#<member>` (instance)
   * then `<enclosingType>.<member>` (associated function) constrained
   * to the caller's own file. Mirrors `JavaCallResolver.lookupEnclosingMember`
   * — Rust shares the convention (instance methods use `#`, associated
   * functions use `.`) so the same lookup works.
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

function rustImportMatchesReceiver(importText: string, receiver: string): boolean {
  // Strip `crate::`, `super::`, `self::` prefixes.
  const cleaned = importText.replace(/^(crate|super|self)::/, "");
  const segments = cleaned.split("::");
  const last = segments[segments.length - 1]?.trim() ?? "";
  // Group import `{a, b, c}` — receiver matches if it appears in the
  // braced list.
  if (last.startsWith("{") && last.endsWith("}")) {
    const inner = last
      .slice(1, -1)
      .split(",")
      .map((s) => s.trim());
    return inner.includes(receiver);
  }
  return last === receiver;
}

function rustImportSuffix(importText: string): string | null {
  // Reduce import to its module path component (suffix), dropping
  // crate-prefix and any terminal `{...}` group.
  const cleaned = importText.replace(/^(crate|super|self)::/, "");
  const segments = cleaned.split("::");
  // Drop the trailing item if it's brace-wrapped (the suffix is the
  // path up to that segment).
  const last = segments[segments.length - 1]?.trim() ?? "";
  if (last.startsWith("{")) {
    return segments.slice(0, -1).join("/");
  }
  return segments.join("/");
}
