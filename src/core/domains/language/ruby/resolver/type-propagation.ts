/**
 * Ruby receiver type-propagation engine — multi-hop chain threading (Increment 1, Task 1.4).
 *
 * Exposes {@link typeOfReceiver}: given a raw receiver string + call line + the
 * per-file {@link CallContext}, resolves the static {@link RubyTypeRef} for
 * single-hop receivers (local variable bindings and `@ivar` field types) and
 * multi-hop dotted chains (`a.b.c.d`) via the propagation engine.
 *
 * **Scope of this module:**
 * - Local variable → `LocalBinding` via `resolveLocalBinding` → `RubyTypeRef`.
 * - `@ivar` → {@link ivarTypeName}: `ctx.ivarTypes` (declared types, merged
 *   run-global by the codegraph provider — empty until a Sorbet/RBS source
 *   emits `kind:"ivar"` facts) then `ctx.classFieldTypes` (the live channel:
 *   walker AST inference over `@x = Const.new`).
 * - Dotted chain receiver (`a.b.c`) → multi-hop threading via {@link returnTypeOf}
 *   seeded from the head segment and walked left-to-right. Capped at
 *   `CODEGRAPH_RB_CHAIN_MAX_HOPS` (default 4).
 * - Constants / `self` / `super` → `undefined`. Index-access on a TYPED
 *   container yields the element type (Task 1.6); untyped index → `undefined`.
 *
 * **Wired.** Consumed by the ruby dynamic-dispatch, chain-type, and
 * union-dispatch strategies; the codegraph provider merges
 * `ctx.structuredReturnTypes` / `ctx.ivarTypes` run-global from the per-file
 * extractions (bd 9bliu) — whatever the type sources put there.
 *
 * **The fold moved; the vocabulary did not** (E1 seam 3). The dotted-chain walk
 * itself — hop cap, STOP-at-unknown, the receiver-form collapse — lives in
 * `kernel/receiver-type-propagation.ts` and is shared with every language. What
 * stays here is everything that names Ruby: `@ivar`, the `::`-scoped constant
 * head, the nullary self-call fallback, the gem catalogue, and the
 * `CODEGRAPH_RB_CHAIN_MAX_HOPS` cap — supplied to the fold as
 * {@link RUBY_RECEIVER_TYPE_PORTS}.
 *
 * **This file is the ADDRESS of the whole engine, not all of its code**
 * (bd tea-rags-mcp-uetqq). The channels it threads live in collaborator modules
 * beside it and are re-exported below the imports, so every consumer keeps
 * importing from here:
 * - `ruby-member-return-types.ts` — {@link returnTypeOf}, the five-channel
 *   authority for "what does calling `member` on this type yield", plus the
 *   container vocabularies;
 * - `ruby-return-facts.ts` — where a declared `<class>#<member>` return fact
 *   lives and how Ruby's MRO reaches it;
 * - `ruby-active-record-return-types.ts` — the AR query-interface vocabulary
 *   channel, consulted only after every declared fact;
 * - `ruby-unbound-receiver-types.ts` — nullary-self and naming-convention
 *   receiver typing;
 * - `ruby-bound-call-return-types.ts` — the `localCallBindings` channel.
 */

import { resolveLocalBinding, type CallContext } from "../../../../contracts/types/codegraph.js";
import type { RubyTypeRef } from "../../../../contracts/types/language.js";
import {
  CHAIN_MAX_HOPS_DEFAULT,
  propagateReceiverType,
  stripCallArgs,
  type ReceiverTypePorts,
} from "../../kernel/receiver-type-propagation.js";
import { catalogueForGemfile } from "../gemfile.js";
import { returnTypeOf } from "./ruby-member-return-types.js";
import { declaredReturnType } from "./ruby-return-facts.js";
import { nullaryReceiverType } from "./ruby-unbound-receiver-types.js";

export { boundCallReturnType } from "./ruby-bound-call-return-types.js";
export { CHAIN_MAX_HOPS_DEFAULT } from "../../kernel/receiver-type-propagation.js";
export {
  CONTAINER_BLOCK_ITERATION_METHODS,
  CONTAINER_ELEMENT_RETURNING_METHODS,
  returnTypeOf,
} from "./ruby-member-return-types.js";
export { conventionReceiverType } from "./ruby-unbound-receiver-types.js";

/** `@ivar` — a single leading `@` followed by word characters only. */
const IVAR_RECEIVER = /^@\w+$/;

/** A bare constant chain head: `Foo`, `Mod::Svc`. Capitalized, optional `::` scope. */
const CONST_HEAD = /^[A-Z]\w*(?:::[A-Z]\w*)*$/;

/**
 * Read the effective chain hop cap from env, falling back to `CHAIN_MAX_HOPS_DEFAULT`.
 * The `maxHops` port: the kernel fold calls it per chain so env-variable test
 * overrides take effect without needing a module reload.
 */
function chainMaxHops(): number {
  const raw = process.env.CODEGRAPH_RB_CHAIN_MAX_HOPS;
  if (raw === undefined) return CHAIN_MAX_HOPS_DEFAULT;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : CHAIN_MAX_HOPS_DEFAULT;
}

/**
 * Ruby's four answers for the shared chain fold
 * (`kernel/receiver-type-propagation.ts`). Frozen module-level singleton: the
 * fold threads `ctx` as an argument, so nothing is allocated per call site.
 */
export const RUBY_RECEIVER_TYPE_PORTS: ReceiverTypePorts = Object.freeze({
  singleHopType: rubySingleHopType,
  seedHead: rubySeedHead,
  memberTypeOf: (recv: RubyTypeRef, member: string, ctx: CallContext) => returnTypeOf(recv, member, ctx),
  maxHops: chainMaxHops,
});

/**
 * Resolve the static {@link RubyTypeRef} for a receiver — single-hop or
 * multi-hop dotted chain.
 *
 * @param receiver - Raw receiver text from the call site (e.g. `"user"`, `"@client"`, `"a.b.c"`).
 * @param atLine   - 1-based source line of the call; used for position-aware
 *                   local-binding lookup (`LocalBinding.line <= atLine`).
 * @param ctx      - Per-call {@link CallContext} carrying `localBindings`,
 *                   `ivarTypes`, `classFieldTypes`, `associationTypes`,
 *                   `structuredReturnTypes`, `functionReturnTypes`,
 *                   `classAncestors`, and `callerScope`.
 * @returns A {@link RubyTypeRef} when the receiver's static type is known;
 *          `undefined` for unknowable receivers (constants, self, super,
 *          untyped index-access, unbound variables, or chains with an unknown hop).
 *
 * Every answer passes through {@link rubyReceiverForm}, so a NILABLE type
 * (bd tea-rags-mcp-27q0z) reaches callers as the one arm a call on it can
 * actually dispatch to. The fact channels keep stating `Firm|nil`; receiver
 * position is where that resolves to `Firm`, because `nil.foo` reaches no
 * in-project definition.
 */
export function typeOfReceiver(receiver: string, atLine: number, ctx: CallContext): RubyTypeRef | undefined {
  return propagateReceiverType(receiver, atLine, ctx, RUBY_RECEIVER_TYPE_PORTS);
}

/** Ruby's `singleHopType` port: a receiver with no dot in it. */
function rubySingleHopType(receiver: string, atLine: number, ctx: CallContext): RubyTypeRef | undefined {
  // ── Index-access on a typed container: `arr[i]` → element type (Task 1.6) ─
  // When the outermost operation is `[...]` and the base var has a container
  // binding, return the element type so call sites like `arr[0].title` can
  // resolve to the element class rather than being suppressed as untrackable.
  // UNTYPED containers (no binding or non-container typeRef) return `undefined`
  // — suppression is preserved as before.
  const trimmed = receiver.trimEnd();
  if (trimmed.endsWith("]") && trimmed.includes("[")) {
    const bracketIdx = trimmed.indexOf("[");
    const baseVar = bracketIdx > 0 ? trimmed.slice(0, bracketIdx) : "";
    if (baseVar && /^[a-z_]\w*$/.test(baseVar)) {
      const baseBinding = resolveLocalBinding(ctx.localBindings, baseVar, atLine);
      if (baseBinding?.typeRef?.form === "container") {
        return baseBinding.typeRef.element;
      }
    }
    // Untyped index-access → undefined (suppression unchanged).
    return undefined;
  }

  // ── @ivar ───────────────────────────────────────────────────────────────
  if (IVAR_RECEIVER.test(receiver)) {
    return resolveIvarType(receiver, ctx);
  }

  // ── Local variable binding ───────────────────────────────────────────────
  // Only plain lowercase identifiers can be local variables in Ruby. A
  // capitalized identifier is a constant; `self`/`super` are keywords. We rely
  // on `resolveLocalBinding` returning `undefined` for constants/keywords (no
  // binding recorded), so no pre-filter on casing is strictly required — but
  // dotted receivers and ivars are already guarded above, and index-access
  // (`arr[0]`) is handled above. The explicit chain guard above is the only
  // structural guard needed.
  const binding = resolveLocalBinding(ctx.localBindings, receiver, atLine);
  // ── Nullary self-call receiver (bd tea-rags-mcp-pr7fu) ───────────────────
  // An unbound lowercase identifier in receiver position is not a variable —
  // Ruby has no implicit declaration, so `current_client.foo` can only be a
  // ZERO-ARG method call on self or an ancestor. Its return fact types the
  // receiver exactly as a local binding would.
  if (!binding) return nullaryReceiverType(receiver, ctx);

  // Prefer the richer typeRef (union / container) when present (INFRA-A);
  // fall back to reconstructing from type + valueKind for plain bindings.
  return (
    binding.typeRef ?? {
      form: binding.valueKind === "class" ? "class" : "instance",
      name: binding.type,
    }
  );
}

/**
 * A bare-constant chain head. Two ways the first link can be typed, declared
 * facts FIRST:
 *
 *  1. DECLARED (bd tea-rags-mcp-6zpds) — the project itself states what the
 *     member returns on that constant (`scope :without_deleted` →
 *     `container(Owner)`, a YARD `@return`, an inherited fact). Custom scopes
 *     live only here; the generic vocabulary cannot know them.
 *  2. VOCABULARY (rvw34 gap b) — a framework/Ruby instance-returning verb
 *     (`new`/`find`/`create!`…) makes the chain an instance of the constant:
 *     `PostStatusService.new` is definitionally a PostStatusService.
 *
 * Both are zero-fabrication. A bare-const head that is neither declared nor
 * vocabulary (`Config.value`) is still NOT typed.
 */
function rubySeedHead(
  head: string,
  firstLink: string | undefined,
  ctx: CallContext,
): { type: RubyTypeRef; consumedMembers: 0 | 1 } | undefined {
  if (firstLink === undefined || !CONST_HEAD.test(head)) return undefined;
  const firstMember = stripCallArgs(firstLink);
  const declared = declaredReturnType(head, firstMember, ctx);
  if (declared !== undefined) return { type: declared, consumedMembers: 1 };
  if (catalogueForGemfile(ctx.gemfileContent).instanceReturning.has(firstMember)) {
    return { type: { form: "instance", name: head }, consumedMembers: 1 };
  }
  return undefined;
}

/**
 * The ONE authority for "what type does `@ivar` hold inside the caller's class"
 * (bd tea-rags-mcp-wr7ku). Two channels carry ivar types and every reader must
 * consult both, in this order:
 *
 *  1. `ctx.ivarTypes` — type-SOURCE facts (`RubyTypeFact` of `kind:"ivar"`,
 *     merged run-global by the codegraph provider). Declared types win.
 *  2. `ctx.classFieldTypes` — the walker's AST inference over `@x = Const.new`
 *     assignments (`collectRubyIvarFieldTypes`), per-file. The channel that
 *     actually carries facts today: no INLINE type source emits `kind:"ivar"`
 *     yet, so (1) stays empty until a sidecar/Sorbet source lands.
 *
 * The enclosing-class key is `ctx.callerScope.join("::")` — the same key
 * `collectRubyClassAncestors` / `collectRubyIvarFieldTypes` produce. Unknown
 * ivar → `undefined`; callers own the resulting silence.
 */
export function ivarTypeName(ivar: string, ctx: CallContext): string | undefined {
  if (ctx.callerScope.length === 0) return undefined;
  const scopeKey = ctx.callerScope.join("::");
  return ctx.ivarTypes?.[scopeKey]?.[ivar] ?? ctx.classFieldTypes?.[scopeKey]?.[ivar];
}

/** {@link ivarTypeName} lifted to the engine's structured ref (always instance form). */
function resolveIvarType(ivar: string, ctx: CallContext): RubyTypeRef | undefined {
  const name = ivarTypeName(ivar, ctx);
  return name === undefined ? undefined : { form: "instance", name };
}
