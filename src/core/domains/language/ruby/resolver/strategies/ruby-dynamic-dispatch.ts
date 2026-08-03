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
import { resolveConventionReceiverTarget } from "./ruby-convention-receiver.js";
import { RUBY_DUCK_VOCAB } from "./ruby-duck-vocabulary.js";
import { ivarFieldOwnsReceiver, resolveIvarFieldTarget } from "./ruby-ivar-field.js";
import { resolveBoundCallTarget } from "./ruby-return-type-binding.js";
import {
  DYNAMIC_RECEIVER_CONFIDENCE_DEFAULT,
  isRubyPath,
  receiverChainTailIsExternal,
  receiverIsIndexAccess,
  resolveConstant,
  type ResolverConfig,
} from "./shared.js";

/** Ruby constants begin uppercase; `::`-joined segments form a scope chain. */
const CONSTANT_RE = /^[A-Z][A-Za-z0-9_]*(?:::[A-Z][A-Za-z0-9_]*)*$/;

/**
 * A chain receiver ROOTED in an external constant (`Capybara.<…>.perform`,
 * `Selenium::WebDriver.<…>.foo`): the whole chain dispatches on a gem / stdlib
 * object, so a same-name in-project def of the member is wrong-type noise.
 *
 * `receiverChainTailIsExternal` only knows a NARROW set of core TAILS
 * (`.headers` / `.backtrace` / …) — its own doc defers the general case to a
 * "root-segment vocab gate". An external ROOT is that general signal. Require:
 *   - a chain (`.`) — a bare constant is the constant-exact path, returned above;
 *   - a constant root (`/^[A-Z]/`) — a lowercase root can't be told apart from a
 *     project receiver, so it stays non-external (conservative, no over-suppress);
 *   - the root resolves to NO in-project file (`resolveConstant → null`) — a
 *     gem / stdlib constant. An in-project root still fans out (unchanged).
 *
 * Suppressing here (not materialising an ambiguous fan-out) lets the external
 * classifier reclassify the drop as `externalSkipped` instead of persisting a
 * meaningless `cg_ambiguous_fanout` aggregate. bd tea-rags-mcp-z9pky (DEFECT 1).
 */
function chainRootConstantIsExternal(receiver: string, ctx: CallContext): boolean {
  if (!receiver.includes(".")) return false;
  const root = receiver.split(/[.([]/)[0]?.trim() ?? "";
  if (!/^[A-Z]/.test(root)) return false;
  return resolveConstant(root, ctx) === null;
}

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
    // Receiver bound to a CALL whose return type is known (`result = Svc.call(…)`;
    // bd tea-rags-mcp-j9xpf). The walker cannot type it — that needs another
    // file's return fact — so there is no `localBindings` entry, yet the
    // `returnTypeBinding` pass in `resolve()` DOES own it and emits ONE precise
    // edge. Defer to it, exactly as the typeable-chain gate below defers to
    // `chainType`. Gated on the resolved TARGET, so a binding the exact path
    // cannot answer still fans out and recall is unchanged.
    if (resolveBoundCallTarget(call, ctx, this.cfg.mode) !== null) return emptyDispatchFanout();
    // Bare `@ivar` receiver the `ivarField` pass ANSWERS (bd tea-rags-mcp-bvalc).
    // It pins exactly one target, but the fan-out ran first and buried that
    // target under every same-named def in the project — `@firm.owner` emitted
    // `Firm#owner` AND `Person#owner`. Same gate shape and same reasoning as the
    // bound-call one above: gated on the RESOLVED target, so an ivar the exact
    // path cannot answer still fans out and the resolve tally is unchanged; only
    // the wrong-type edges beside the right one go.
    //
    // "Answers" spans every tier the pass has, which is why this reads the
    // helper and not a type probe. When the naming convention became its last
    // tier (bd r2gjj) a receiver no fact typed started resolving here, and a
    // fact-only gate could not see it: 1173 taxdome sites kept 6343 discounted
    // `dynamic` edges while the chain emitted their exact edge. Reading the
    // whole answer collapses them, 1173 of 1173 agreeing with what lands
    // (bd tea-rags-mcp-eaml5, `CODEGRAPH_C2COLLAPSE_ORACLE=1` cut 3).
    if (resolveIvarFieldTarget(call, ctx, this.cfg.mode) !== null) return emptyDispatchFanout();
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
    // Root-segment external gate (bd tea-rags-mcp-z9pky / DEFECT 1): a chain
    // rooted in an external constant is external regardless of its tail — the
    // general signal the narrow tail vocab above defers to. Suppress so the
    // external classifier reclassifies to externalSkipped rather than persisting
    // an ambiguous aggregate (taxdome `Capybara…action…release.perform` noise).
    if (chainRootConstantIsExternal(r, ctx)) return emptyDispatchFanout();
    // Typeable receiver: the propagation engine threads it to a known class/
    // instance type, so the precise `chainType` strategy (in resolve()) must own it
    // — returning [] here defers to it instead of fanning out speculative dynamic
    // edges. (bd tea-rags-mcp-epydb)
    //
    // The gate is TYPEDNESS, not receiver shape. It used to also require a dot,
    // mirroring the entry guard `chainType` carried at the time; `chainType`
    // dropped that guard in bd tea-rags-mcp-e8feo once `nullaryReceiverType` and
    // `scopedReceiverType` began typing bare identifiers that `localType` (needs a
    // `localBindings` entry) and `ivarField` (needs an `@`) both decline. Leaving
    // the dot here kept 1188 taxdome sites fanning out to 3794 discounted
    // `dynamic` edges where the chain had an exact answer for 848 of them
    // (bd tea-rags-mcp-55950, `CODEGRAPH_BAREDEFER_ORACLE=1`).
    //
    // The 340 sites the chain does NOT answer lose their fan-out — every one of
    // them because the derived type resolves to no in-project file (`StandardError`,
    // `Array`, `ActionController::Parameters`, `Faraday`), so the edges being
    // removed pointed at a coincidental same-named in-project def. All 340
    // reclassify to `externalSkipped`, and `missWithInProjectDef` does not move by
    // a single call — the recall hole is untouched, only false positives go.
    const t = typeOfReceiver(r, call.startLine, ctx);
    if (t && (t.form === "class" || t.form === "instance")) return emptyDispatchFanout();
    // CONVENTION tier of the same deferral (bd tea-rags-mcp-htffz, residual C2).
    // The gate above defers when a FACT types the receiver. `conventionReceiver`
    // (bd wob7g) derives one exact target for a class of receivers no fact
    // types — the very population that reaches this line — and the fan-out did
    // not know it, so 2704 taxdome sites kept 15554 discounted `dynamic` edges
    // while an exact edge was derivable for every one of them.
    //
    // Gated on the RESOLVED target, exactly like the `ivarField` and bound-call
    // gates above: a receiver the convention cannot type, whose derived class has
    // subtypes, or whose class declares no such member still fans out, so the
    // resolve tally is unchanged and only wrong-type edges go.
    //
    // `ivarFieldOwnsReceiver` is the one carve-out, and it is a REACHABILITY fact
    // rather than a precision one: `ivarField` terminates the chain nine slots
    // before `conventionReceiver` runs, so deferring to that pass for a receiver
    // `ivarField` DROPs would trade N discounted edges for NO edge at all. The
    // `@ivar` receivers the convention CAN answer no longer reach this line —
    // the gate above collapses them through `ivarField`'s own tier (bd eaml5) —
    // so what remains here is exactly the DROP population the carve-out is for.
    if (!ivarFieldOwnsReceiver(call, ctx) && resolveConventionReceiverTarget(call, ctx, this.cfg.mode) !== null) {
      return emptyDispatchFanout();
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
