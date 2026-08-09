import {
  emptyDispatchFanout,
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
import { RUBY_DUCK_VOCAB } from "./ruby-duck-vocabulary.js";
import { rubyDynamicFanoutSuppressed } from "./ruby-dynamic-fanout-gates.js";
import { DYNAMIC_RECEIVER_CONFIDENCE_DEFAULT, isRubyPath, type ResolverConfig } from "./shared.js";

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
 * The full gate run — those shapes plus the exact passes that answer, the
 * index-access suppression, the external-chain signals, the typed/convention
 * deferrals and the external-member gate — lives in
 * {@link rubyDynamicFanoutSuppressed}, in the order it has always evaluated.
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
    if (rubyDynamicFanoutSuppressed(call, ctx, this.cfg.mode)) return emptyDispatchFanout();

    // Truly dynamic receiver: short-name lookup, ruby-files only.
    const candidates = ctx.symbolTable.lookupByShortName(call.member).filter((def) => isRubyPath(def.relPath));
    if (candidates.length === 0) return emptyDispatchFanout();
    const discount = this.cfg.dynamicReceiverConfidence ?? DYNAMIC_RECEIVER_CONFIDENCE_DEFAULT;
    return resolveNarrowedFanout(call, candidates, ctx, this.narrowers, discount);
  }
}
