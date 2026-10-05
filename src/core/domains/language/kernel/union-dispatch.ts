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
import type { DispatchResolverComponent } from "../../../contracts/types/language.js";
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

    const seen = new Set<string>();
    const targets: { targetRelPath: string; targetSymbolId: string }[] = [];
    for (const arm of type.members) {
      const target = this.lookup.findMember(arm, call.member, ctx);
      if (!target) continue;
      if (!this.ports.ownsPath(target.targetRelPath)) continue;
      if (target.targetSymbolId === null) continue;
      if (seen.has(target.targetSymbolId)) continue;
      seen.add(target.targetSymbolId);
      targets.push({ targetRelPath: target.targetRelPath, targetSymbolId: target.targetSymbolId });
    }

    const n = targets.length;
    if (n === 0 || n > this.coneMax) return [];
    const confidence = 1 / n;
    return targets.map((target) => ({
      sourceSymbolId: null,
      targetRelPath: target.targetRelPath,
      targetSymbolId: target.targetSymbolId,
      edgeKind: "cone",
      confidence,
    }));
  }
}
