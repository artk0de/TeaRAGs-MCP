/**
 * Shared inputs and helpers for the Rust symbol-resolution strategies.
 *
 * `ResolverConfig` is the per-resolver config every strategy receives by
 * constructor injection (the old `RustCallResolver(mode)` argument). The shared
 * helpers below are the lookups several strategies use — factored here so they
 * live once.
 */

import {
  pickSingleCandidate,
  type AmbiguousResolveMode,
  type CallContext,
  type SymbolDefinition,
  type SymbolResolutionTarget,
} from "../../../../../contracts/types/codegraph.js";

export interface ResolverConfig {
  mode: AmbiguousResolveMode;
}

/**
 * bd tea-rags-mcp-c5by — look up `<enclosingType>#<member>` (instance)
 * then `<enclosingType>.<member>` (associated function) constrained
 * to the caller's own file. Mirrors `JavaCallResolver.lookupEnclosingMember`
 * — Rust shares the convention (instance methods use `#`, associated
 * functions use `.`) so the same lookup works.
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

/**
 * bd tea-rags-mcp-p8wz — resolve a bound-type member (`<Type>#<member>` /
 * `<Type>.<member>`) preferring the candidate in the caller's own file when the
 * type name collides across files. ripgrep declares `Parser` in BOTH
 * `crates/core/flags/parse.rs` and `crates/globset/src/glob.rs`, so a typed
 * binding `let parser = Parser::new(); parser.parse()` inside parse.rs would
 * otherwise hit two `Parser#parse` rows and drop on ambiguity. A locally
 * declared type's method is local — Rust name resolution, not a guess. Only a
 * unique same-file candidate shortcuts; everything else defers to the ambiguity
 * policy (which still drops genuinely cross-file collisions).
 */
export function pickSameFileThenSingle(
  candidates: SymbolDefinition[],
  callerFile: string,
  mode: AmbiguousResolveMode,
): SymbolDefinition | null {
  const sameFile = candidates.filter((def) => def.relPath === callerFile);
  if (sameFile.length === 1) return sameFile[0];
  return pickSingleCandidate(candidates, mode);
}

export function rustImportMatchesReceiver(importText: string, receiver: string): boolean {
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

export function rustImportSuffix(importText: string): string | null {
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
