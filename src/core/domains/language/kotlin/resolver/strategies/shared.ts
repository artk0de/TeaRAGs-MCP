import {
  pickSingleCandidate,
  type AmbiguousResolveMode,
  type CallContext,
  type SymbolResolutionTarget,
} from "../../../../../contracts/types/codegraph.js";
import type { NominalTypeRef } from "../../../kernel/index.js";
import { capability } from "../../capability.js";

export interface ResolverConfig {
  mode: AmbiguousResolveMode;
}

/**
 * Same-file member of the enclosing type. `Owner#member` is the instance id
 * `classifyMethod` emits for a Kotlin `fun`; `Owner.member` is the companion
 * / static id. Instance is tried first so `this.method()` prefers it when
 * both spellings exist.
 */
export function lookupKotlinSameFileMember(
  scope: readonly string[],
  member: string,
  ctx: CallContext,
): SymbolResolutionTarget | null {
  if (scope.length === 0 || member.length === 0) return null;
  const owner = scope.join(".");
  const kinds = capability.codegraph.symbolKindRoles.callee;
  for (const symbolId of [`${owner}#${member}`, `${owner}.${member}`]) {
    const hit = ctx.symbolTable.lookup(symbolId, { kinds }).find((def) => def.relPath === ctx.callerFile);
    if (hit) return { targetRelPath: hit.relPath, targetSymbolId: hit.symbolId };
  }
  return null;
}

/**
 * `Type#member` then `Type.member` anywhere in the index. A miss is null —
 * an unknown or not-yet-indexed type does not become a fabricated target.
 * Two definitions of the same id stay unresolved under `strict`.
 */
export function lookupKotlinTypeMember(
  type: NominalTypeRef,
  member: string,
  ctx: CallContext,
  mode: AmbiguousResolveMode,
): SymbolResolutionTarget | null {
  if (type.name.length === 0 || member.length === 0) return null;
  const kinds = capability.codegraph.symbolKindRoles.callee;
  const spellings =
    type.form === "class"
      ? [`${type.name}.${member}`, `${type.name}#${member}`]
      : [`${type.name}#${member}`, `${type.name}.${member}`];
  for (const symbolId of spellings) {
    const hit = pickSingleCandidate(ctx.symbolTable.lookup(symbolId, { kinds }), mode);
    if (hit) return { targetRelPath: hit.relPath, targetSymbolId: hit.symbolId };
  }
  return null;
}
