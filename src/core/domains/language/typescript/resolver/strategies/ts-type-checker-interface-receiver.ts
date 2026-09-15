/**
 * Interface-typed receivers the walker could not type, dispatched to their
 * implementers through the CHA cone (bd tea-rags-mcp-hwwtw).
 *
 * `ConeDispatchResolver` already answers "which classes can this interface-typed
 * call land on": descendants of the base type in the run hierarchy, narrowed to
 * the ones that declare the member, `cone` edges at `1/N`, `poly-base` over the
 * cap. It takes the base type from the walker's `localBindings`, and the walker
 * binds nothing for a destructured value, an unannotated local initialised from
 * a call, or a `this.<field>` receiver — so for exactly those the cone returned
 * `[]` and the call fell through to the name-matching passes. On this repo that
 * was `walkCommits`'s `diffMemo?.set(...)`, answered by global short-name
 * uniqueness until a second `set` appeared anywhere in `src`.
 *
 * This component supplies the missing base type from the checker — through
 * {@link receiverProjectInterfaceNames}, the same predicate the short-name pass
 * declines on — and re-asks the SAME cone with it. Nothing about the fan-out is
 * decided here, so an interface receiver typed by the walker and one typed by
 * the checker get one algorithm, one cap and one confidence rule.
 *
 * Several interfaces (a union or an intersection of them) are asked one by one
 * and merged: the `cone` edges are deduplicated by target, capped at `coneMax`
 * and re-split to `1/N`, mirroring `TSTypeCheckerUnionReceiverDispatchResolver`,
 * whose union has no single base declaration to collapse a `poly-base` onto
 * either — so an over-cap member drops out of the merge rather than pointing at
 * one of the interfaces.
 *
 * It runs AFTER the walker-typed cone and only when that cone was empty, and it
 * declines outright for a receiver the walker DID bind: there the cone already
 * had its base type and its empty answer stands.
 */

import {
  resolveLocalBindingType,
  type CallContext,
  type CallRef,
  type DispatchEdge,
  type DispatchFanoutOutcome,
} from "../../../../../contracts/types/codegraph.js";
import type { DispatchResolverComponent } from "../../../../../contracts/types/language.js";
import { receiverProjectInterfaceNames } from "../ts-interface-receiver.js";
import type { TSProgramCache } from "../ts-program-cache.js";
import { CONE_MAX_DEFAULT, type ResolverConfig } from "./shared.js";

export class TSTypeCheckerInterfaceReceiverDispatchResolver implements DispatchResolverComponent {
  constructor(
    private readonly cfg: ResolverConfig,
    private readonly programCache: TSProgramCache,
    private readonly cone: DispatchResolverComponent,
  ) {}

  resolveDispatch(call: CallRef, ctx: CallContext): DispatchFanoutOutcome {
    return { kind: "edges", edges: this.resolveDispatchEdges(call, ctx) };
  }

  private resolveDispatchEdges(call: CallRef, ctx: CallContext): DispatchEdge[] {
    const { receiver } = call;
    if (receiver === null || ctx.hierarchy === undefined) return [];
    if (resolveLocalBindingType(ctx.localBindings, receiver, call.startLine) !== undefined) return [];

    const interfaces = receiverProjectInterfaceNames(call, ctx, this.programCache);
    if (interfaces.length === 0) return [];
    if (interfaces.length === 1) return this.coneEdges(call, ctx, interfaces[0]);

    const byTarget = new Map<string, DispatchEdge>();
    for (const typeName of interfaces) {
      for (const edge of this.coneEdges(call, ctx, typeName)) {
        if (edge.edgeKind !== "cone" || edge.targetSymbolId === null) continue;
        byTarget.set(edge.targetSymbolId, edge);
      }
    }
    if (byTarget.size === 0 || byTarget.size > (this.cfg.coneMax ?? CONE_MAX_DEFAULT)) return [];
    const confidence = 1 / byTarget.size;
    return [...byTarget.values()].map((edge) => ({ ...edge, confidence }));
  }

  /** The cone's answer with `typeName` bound to the receiver at the call's own line. */
  private coneEdges(call: CallRef, ctx: CallContext, typeName: string): DispatchEdge[] {
    const receiver = call.receiver ?? "";
    const typed: CallContext = {
      ...ctx,
      localBindings: { ...ctx.localBindings, [receiver]: [{ line: call.startLine, type: typeName }] },
    };
    const outcome = this.cone.resolveDispatch(call, typed);
    return outcome.kind === "edges" ? outcome.edges : [];
  }
}
