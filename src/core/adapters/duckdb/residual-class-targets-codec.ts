/**
 * Column codec for `cg_residual_call_sites.class_targets` (061, bd
 * tea-rags-mcp-2m83f.50): the receiver group's class set repeats on every row
 * of the group, so the default target spelling is left out.
 */

import type { ResidualClassTarget } from "../../contracts/types/codegraph-residual.js";

/** Stored entry: `[class]`, `[class, null, returnType]` when the target is `class#member`, else `[class, target, returnType?]`. */
type StoredClassTarget = [className: string, targetSymbolId?: string | null, returnType?: string];

/** `member` is the row's member: a target spelled `${class}#${member}` is stored as null, or dropped when last. */
export function encodeResidualClassTargets(member: string, targets: readonly ResidualClassTarget[]): string {
  const stored = targets.map(([cls, target, returnType]): StoredClassTarget => {
    if (target !== `${cls}#${member}`) return returnType === undefined ? [cls, target] : [cls, target, returnType];
    return returnType === undefined ? [cls] : [cls, null, returnType];
  });
  return JSON.stringify(stored);
}

/** Reads the compact form and the full form written before it. */
export function decodeResidualClassTargets(member: string, value: string): ResidualClassTarget[] {
  return (JSON.parse(value) as StoredClassTarget[]).map(([cls, target, returnType]): ResidualClassTarget => {
    const symbolId = target ?? `${cls}#${member}`;
    return returnType === undefined ? [cls, symbolId] : [cls, symbolId, returnType];
  });
}
