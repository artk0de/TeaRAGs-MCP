/**
 * An accepted receiver-group verdict as a type fact downstream (codegraph
 * residual wave 1.5, design §3 "Answer becomes a type fact"): a group accepted
 * as `C` gives every row the return type of its class target on `C`, and that
 * type answers the group whose receiver is the row's call (`record.firm` for
 * `record.firm.name`). Two fixpoint rounds; a group's own accepted verdict
 * beats a propagated type.
 */
import type { ModelEdgeRow } from "../../../../contracts/types/codegraph-residual.js";
import type { ReceiverGroup } from "./receiver-group-tournament.js";

/** Hops a type fact travels past the accepted group: `a` accepted reaches `a.b.c.d`. */
export const PROPAGATION_ROUNDS = 2;

/** A group's accepted direct verdict: the class picked, or `null` for none. */
export interface AcceptedGroupVerdict {
  pick: string | null;
  p: number;
}

interface PropagatedType {
  cls: string;
  p: number;
}

/** `(file, receiver group)` — the address a row's `downstreamGroup` names. */
export function receiverGroupAddress(group: ReceiverGroup): string {
  return `${group.sourceRelPath}\u0000${group.rows[0]?.receiverGroup ?? ""}`;
}

/**
 * Edges of the groups a propagated type fact answers, each with the `p` of the
 * verdict it started from. `direct` holds every group's accepted verdict by
 * {@link receiverGroupAddress}; a group in it is never edged here, and a type
 * fact disagreeing with it counts as a conflict. Two facts disagreeing on one
 * group leave it unedged.
 */
export function propagateTypeFacts(
  groups: readonly ReceiverGroup[],
  direct: ReadonlyMap<string, AcceptedGroupVerdict>,
  model: string,
): { edges: ModelEdgeRow[]; conflicts: number } {
  const byAddress = new Map(groups.map((g) => [receiverGroupAddress(g), g]));
  const propagated = new Map<string, PropagatedType>();
  const contested = new Set<string>();
  const conflicted = new Set<string>();
  let frontier = new Map<string, PropagatedType>();
  for (const [address, verdict] of direct) {
    if (verdict.pick !== null) frontier.set(address, { cls: verdict.pick, p: verdict.p });
  }
  for (let round = 0; round < PROPAGATION_ROUNDS && frontier.size > 0; round++) {
    const next = new Map<string, PropagatedType>();
    for (const [address, fact] of frontier) {
      const group = byAddress.get(address);
      if (group === undefined) continue;
      for (const row of group.rows) {
        const returnType = row.classTargets?.find(([cls]) => cls === fact.cls)?.[2];
        if (returnType === undefined || row.downstreamGroup === undefined) continue;
        const target = `${row.sourceRelPath}\u0000${row.downstreamGroup}`;
        const downstream = byAddress.get(target);
        if (!downstream?.classes.includes(returnType)) continue;
        const own = direct.get(target);
        if (own !== undefined) {
          if (own.pick !== returnType) conflicted.add(target);
          continue;
        }
        const known = propagated.get(target) ?? next.get(target);
        if (known !== undefined) {
          if (known.cls !== returnType) contested.add(target);
          else known.p = Math.min(known.p, fact.p);
          continue;
        }
        next.set(target, { cls: returnType, p: fact.p });
      }
    }
    for (const [address, fact] of next) propagated.set(address, fact);
    frontier = new Map([...next].filter(([address]) => !contested.has(address)));
  }

  const edges: ModelEdgeRow[] = [];
  for (const [address, fact] of propagated) {
    if (contested.has(address)) continue;
    for (const row of byAddress.get(address)?.rows ?? []) {
      const target = row.classTargets?.find(([cls]) => cls === fact.cls)?.[1];
      if (target === undefined) continue;
      edges.push({
        siteKey: row.siteKey,
        sourceRelPath: row.sourceRelPath,
        sourceSymbolId: row.methodSymbolId,
        targetSymbolId: target,
        model,
        p: fact.p,
      });
    }
  }
  return { edges, conflicts: conflicted.size };
}
