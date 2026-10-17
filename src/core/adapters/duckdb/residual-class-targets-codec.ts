/**
 * Column codec for `cg_residual_call_sites.class_targets` (061, bd
 * tea-rags-mcp-2m83f.50): the receiver group's class set repeats on every row
 * of the group, so the default target spelling is left out. A set over
 * {@link ROW_CLASS_TARGETS_LIMIT} classes is stored once in
 * `cg_residual_class_sets` (063, bd tea-rags-mcp-2m83f.52) under
 * {@link residualClassSetKey}, and the row carries the key.
 */
import { createHash } from "node:crypto";

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

/** Most classes a row keeps inline; a larger set is shared through `cg_residual_class_sets`. */
export const ROW_CLASS_TARGETS_LIMIT = 40;

/** Key of an encoded class set: the same set reached through the same member is one row of `cg_residual_class_sets`. */
export function residualClassSetKey(member: string, encoded: string): string {
  return createHash("sha1").update(`${member}\u0000${encoded}`).digest("hex");
}
