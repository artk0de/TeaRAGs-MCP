import {
  emptyDispatchFanout,
  resolveLocalBinding,
  type CallContext,
  type CallRef,
  type DispatchFanoutOutcome,
} from "../../../../../contracts/types/codegraph.js";
import type { DispatchResolverComponent } from "../../../../../contracts/types/language.js";
import {
  ArityNarrower,
  BlockNarrower,
  DuckVocabularyNarrower,
  KwargNarrower,
  LiteralReceiverNarrower,
  resolveNarrowedFanout,
  VisibilityNarrower,
} from "../../../kernel/dispatch-narrowing.js";
import { isExternalQualifiedMember } from "../../dsl/index.js";
import { SUPER_RECEIVER_SENTINEL } from "../../walker/walker.js";
import { typeOfReceiver } from "../type-propagation.js";
import { receiverLooksLikeArRelationChain } from "./ruby-ar-relation-guard.js";
import { RUBY_DUCK_VOCAB } from "./ruby-duck-vocabulary.js";
import {
  DYNAMIC_RECEIVER_CONFIDENCE_DEFAULT,
  isRubyPath,
  receiverChainTailIsExternal,
  receiverIsIndexAccess,
  type ResolverConfig,
} from "./shared.js";

/** Ruby constants begin uppercase; `::`-joined segments form a scope chain. */
const CONSTANT_RE = /^[A-Z][A-Za-z0-9_]*(?:::[A-Z][A-Za-z0-9_]*)*$/;

/**
 * Map a literal-receiver source text to its Ruby core type (bd d9o7o), or
 * `null` when the receiver is not a recognised literal. Fed to the neutral
 * `LiteralReceiverNarrower`: a literal receiver's type is statically certain,
 * so a same-name in-project method on an UNRELATED class is wrong-type noise.
 * `true`/`false`/`nil` are skipped (no useful in-project reopen target).
 */
export function classifyRubyLiteralReceiver(receiver: string | null): string | null {
  if (receiver === null || receiver.length === 0) return null;
  const c = receiver[0];
  if (c === '"' || c === "'") return "String";
  if (c === "[") return "Array";
  if (c === "{") return "Hash";
  if (c === ":") return "Symbol";
  if (/^-?\d+$/.test(receiver)) return "Integer";
  if (/^-?\d+\.\d+$/.test(receiver)) return "Float";
  return null;
}

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
  private readonly narrowers = [
    new DuckVocabularyNarrower(RUBY_DUCK_VOCAB),
    new LiteralReceiverNarrower(classifyRubyLiteralReceiver),
    new ArityNarrower(),
    new KwargNarrower(),
    new VisibilityNarrower(),
    new BlockNarrower(),
  ];

  constructor(private readonly cfg: ResolverConfig) {}

  resolveDispatch(call: CallRef, ctx: CallContext): DispatchFanoutOutcome {
    const r = call.receiver;
    // Receivers the exact chain owns — never a dynamic fan-out.
    if (r === null) return emptyDispatchFanout(); // bare call
    if (r === SUPER_RECEIVER_SENTINEL || r === "self") return emptyDispatchFanout();
    if (CONSTANT_RE.test(r)) return emptyDispatchFanout(); // constant / type receiver
    if (ctx.localBindings && Object.prototype.hasOwnProperty.call(ctx.localBindings, r)) return emptyDispatchFanout(); // typed local
    if (receiverLooksLikeArRelationChain(r)) return emptyDispatchFanout(); // AR::Relation chain
    // Index-access receiver (`opts[k]`, `arr[i]`): suppress dynamic fan-out by
    // default (element type is untrackable → ~10%-precision noise). EXCEPTION:
    // when the base var has a typed container binding, the element type IS known
    // and `chainType` will resolve the method precisely — return [] here to defer
    // to it rather than fanning out speculative dynamic edges. Untyped index-access
    // keeps the existing suppress behaviour (bd tea-rags-mcp-mktkk increment A;
    // Task 1.6 typed-container lift).
    if (receiverIsIndexAccess(r)) {
      // Attempt to extract the base var: `arr[…]` → `arr`.
      const rtrim = r.trimEnd();
      const bracketIdx = rtrim.indexOf("[");
      const baseVar = bracketIdx > 0 ? rtrim.slice(0, bracketIdx) : "";
      if (baseVar && /^[a-z_]\w*$/.test(baseVar)) {
        const baseBinding = resolveLocalBinding(ctx.localBindings, baseVar, call.startLine);
        if (baseBinding?.typeRef?.form === "container") {
          // Typed container — chainType owns the resolution; defer to it.
          return emptyDispatchFanout();
        }
      }
      // Untyped index-access — suppress as before.
      return emptyDispatchFanout();
    }
    // Provably-external chain tail (`req.headers`, `type.constantize`): the element
    // is core/runtime, no in-project target. Suppress; the external classifier
    // reclassifies so recall is not falsely penalised (bd Increment B / B-suppress).
    if (receiverChainTailIsExternal(r)) return emptyDispatchFanout();
    // Typeable chain receiver: the propagation engine threads it to a known class/
    // instance type, so the precise `chainType` strategy (in resolve()) must own it
    // — returning [] here defers to it instead of fanning out speculative dynamic
    // edges. (bd tea-rags-mcp-epydb)
    if (r.includes(".")) {
      const t = typeOfReceiver(r, call.startLine, ctx);
      if (t && (t.form === "class" || t.form === "instance")) return emptyDispatchFanout();
    }
    // AR/core instance member on an untyped receiver (`agent.update`): the true
    // target is an external base class (ActiveRecord::Base, ActiveModel). Fanning
    // out to a coincidental in-project def of the same name is wrong-type noise.
    // Suppress; the external classifier (Consumer 2) reclassifies so recall is not
    // penalised (bd tea-rags-mcp-i9id8). The receiver is already untyped here — all
    // typed/constant/relation/index/external-chain receivers returned [] above.
    if (isExternalQualifiedMember(call.member)) return emptyDispatchFanout();

    // Truly dynamic receiver: short-name lookup, ruby-files only.
    const candidates = ctx.symbolTable.lookupByShortName(call.member).filter((def) => isRubyPath(def.relPath));
    if (candidates.length === 0) return emptyDispatchFanout();
    const discount = this.cfg.dynamicReceiverConfidence ?? DYNAMIC_RECEIVER_CONFIDENCE_DEFAULT;
    return resolveNarrowedFanout(call, candidates, ctx, this.narrowers, discount);
  }
}
