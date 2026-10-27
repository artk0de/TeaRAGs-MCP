/**
 * K2 union-receiver cone fan-out (bd tea-rags-mcp-m99j1.1.10). A call `x.m`
 * whose receiver is typed as a union `[A, B]` fans out to every arm that
 * defines `m`, as discounted `cone` edges (confidence = 1/N over the targets
 * found, not over the arms).
 *
 * The language owns three ports: the receiver typing (`ReceiverTypingPorts`),
 * the member walk (`TypeMemberLookup`, which answers the nominal `class` /
 * `instance` arms and nothing else), and the population filter `ownsPath`. The
 * kernel owns the rest:
 *
 *   - Non-union receiver, untyped receiver, receiverless call → `[]`.
 *   - Arms in declaration order; an arm the lookup misses is skipped, and so is
 *     a target outside the population or a file-only target (`targetSymbolId`
 *     null) — a union edge is method-level or nothing.
 *   - One edge per distinct `targetSymbolId`.
 *   - `|targets| > coneMax` → `[]`. A union has no single base type, so there
 *     is no `poly-base` collapse; the dynamic resolver downstream handles it.
 */
import type { CallContext, CallRef, DispatchEdge, DispatchFanoutOutcome } from "../../../contracts/types/codegraph.js";
import type { DispatchResolverComponent, TypeRef } from "../../../contracts/types/language.js";
import { hasReceiver, type ReceiverTypingPorts } from "./receiver-typed-strategies.js";
import type { TypeMemberLookup } from "./type-member-lookup.js";

export interface UnionDispatchPorts extends ReceiverTypingPorts {
  /** The language population filter — a union edge never leaves it. */
  ownsPath: (relPath: string) => boolean;
}

export class UnionDispatchResolver implements DispatchResolverComponent {
  constructor(
    private readonly ports: UnionDispatchPorts,
    private readonly lookup: TypeMemberLookup,
    private readonly coneMax: number,
  ) {}

  resolveDispatch(call: CallRef, ctx: CallContext): DispatchFanoutOutcome {
    return { kind: "edges", edges: this.resolveDispatchEdges(call, ctx) };
  }

  private resolveDispatchEdges(call: CallRef, ctx: CallContext): DispatchEdge[] {
    if (!hasReceiver(call)) return [];
    const type = this.ports.typeOfReceiver(call, ctx);
    if (type?.form !== "union") return [];

    const arms = distinctNominalArms(type.members);
    const targets = new Map<string, { targetRelPath: string; targetSymbolId: string; arms: number }>();
    for (const arm of arms) {
      const target = this.lookup.findMember(arm, call.member, ctx);
      if (!target) continue;
      if (!this.ports.ownsPath(target.targetRelPath)) continue;
      if (target.targetSymbolId === null) continue;
      const known = targets.get(target.targetSymbolId);
      if (known !== undefined) known.arms++;
      else targets.set(target.targetSymbolId, { ...target, targetSymbolId: target.targetSymbolId, arms: 1 });
    }

    const n = targets.size;
    if (n === 0 || n > this.coneMax) return [];
    // A target's share is the ARMS reaching it over every nominal arm, not one
    // over the targets that resolved (bd tea-rags-mcp-q1g6s.10): an arm whose
    // lookup missed (an AR column, a gem method) still receives the call at
    // runtime, so `[Owner, Employee, Client]` with only `Client#firm_id` found is
    // a 1-in-3 edge, never confidence 1.
    return [...targets.values()].map((target) => ({
      sourceSymbolId: null,
      targetRelPath: target.targetRelPath,
      targetSymbolId: target.targetSymbolId,
      edgeKind: "cone",
      confidence: target.arms / arms.length,
    }));
  }
}

/** Distinct class / instance arms of a union — the runtime types the call may land on. */
function distinctNominalArms(members: readonly TypeRef[]): TypeRef[] {
  const seen = new Set<string>();
  const arms: TypeRef[] = [];
  for (const arm of members) {
    if (arm.form !== "class" && arm.form !== "instance") continue;
    const key = `${arm.form}:${arm.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    arms.push(arm);
  }
  return arms;
}
