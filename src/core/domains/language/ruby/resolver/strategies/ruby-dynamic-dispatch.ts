import type { CallContext, CallRef, DispatchEdge } from "../../../../../contracts/types/codegraph.js";
import type { DispatchResolverComponent } from "../../../../../contracts/types/language.js";
import { SUPER_RECEIVER_SENTINEL } from "../../walker/walker.js";
import { receiverLooksLikeArRelationChain } from "./ruby-ar-relation-guard.js";
import { DYNAMIC_RECEIVER_CONFIDENCE_DEFAULT, isRubyPath, type ResolverConfig } from "./shared.js";

/** Ruby constants begin uppercase; `::`-joined segments form a scope chain. */
const CONSTANT_RE = /^[A-Z][A-Za-z0-9_]*(?:::[A-Z][A-Za-z0-9_]*)*$/;

/**
 * Dynamic-receiver short-name fan-out (bd tea-rags-mcp-wbj3). A call `recv.m`
 * whose receiver carries NO static type — `arr.map`, `items.each`,
 * `obj[k].call`, a chained/indexed expression — is currently DROPPED by the
 * `receiverSetDrop` guard in the exact chain (the dynamic type is unknown, and
 * guessing a single target fabricates false positives). Rather than drop, this
 * component resolves `m` by global short-name lookup and emits the matches as
 * **discounted** `dynamic` edges: low confidence beats `null`.
 *
 * This is a **fan-out** (N edges with per-edge `confidence`), so it implements
 * `DispatchResolverComponent` — NOT the single-target `SymbolResolutionStrategy`
 * chain, whose `SymbolResolutionTarget` carries no confidence field. It composes
 * behind `RubyCallResolver.resolveDispatch` AFTER the CHA cone: the provider
 * runs `resolveDispatch` first and falls back to the exact chain on `[]`, so a
 * dynamic fan-out slots into the same cone-first path.
 *
 * `resolveDispatch` returns `[]` for every receiver the exact chain OWNS, so
 * exact precedence is preserved and the cone/exact paths stay the default:
 *   - bare call (`receiver === null`)        → bare-call exact path
 *   - super sentinel                          → super exact path
 *   - `self`                                  → self/bare exact path
 *   - constant receiver (`User`, `A::B`)      → constant exact path
 *   - receiver with a local binding           → localType exact path / cone
 *   - AR::Relation chain receiver             → AR-relation guard drop
 *
 * Invariant: an `external` receiver is either a constant (gem class →
 * constant path) or an untyped dynamic receiver whose member has no in-project
 * ruby definition (`[]`) — external receivers never produce a dynamic edge that
 * points outside the project, and `isRubyPath` blocks cross-language pollution
 * (bug pl7k: `arr.map` → vendored `d3.js#map`).
 */
export class RubyDynamicDispatchResolver implements DispatchResolverComponent {
  constructor(private readonly cfg: ResolverConfig) {}

  resolveDispatch(call: CallRef, ctx: CallContext): DispatchEdge[] {
    const r = call.receiver;
    // Receivers the exact chain owns — never a dynamic fan-out.
    if (r === null) return []; // bare call
    if (r === SUPER_RECEIVER_SENTINEL || r === "self") return [];
    if (CONSTANT_RE.test(r)) return []; // constant / type receiver
    if (ctx.localBindings && Object.prototype.hasOwnProperty.call(ctx.localBindings, r)) return []; // typed local
    if (receiverLooksLikeArRelationChain(r)) return []; // AR::Relation chain

    // Truly dynamic receiver: short-name lookup, ruby-files only.
    const candidates = ctx.symbolTable.lookupByShortName(call.member).filter((def) => isRubyPath(def.relPath));
    const n = candidates.length;
    if (n === 0) return [];

    const discount = this.cfg.dynamicReceiverConfidence ?? DYNAMIC_RECEIVER_CONFIDENCE_DEFAULT;
    const confidence = discount / n;
    return candidates.map((def) => ({
      sourceSymbolId: null,
      targetRelPath: def.relPath,
      targetSymbolId: def.symbolId,
      edgeKind: "dynamic",
      confidence,
    }));
  }
}
