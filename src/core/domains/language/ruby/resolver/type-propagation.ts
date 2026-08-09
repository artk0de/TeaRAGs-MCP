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
import { catalogueForGemfile } from "../gemfile.js";
import { rubyReceiverForm } from "../type-ref.js";
import { returnTypeOf } from "./ruby-member-return-types.js";
import { declaredReturnType } from "./ruby-return-facts.js";
import { nullaryReceiverType } from "./ruby-unbound-receiver-types.js";

export { boundCallReturnType } from "./ruby-bound-call-return-types.js";
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

/** Strip a trailing call argument list from a chain segment (`new(post)` → `new`). */
function stripArgs(segment: string): string {
  const paren = segment.indexOf("(");
  return paren === -1 ? segment : segment.slice(0, paren);
}

/**
 * Default maximum chain hops when `CODEGRAPH_RB_CHAIN_MAX_HOPS` is unset.
 * Mirrors the `CONE_MAX_DEFAULT` / `DYNAMIC_RECEIVER_CONFIDENCE_DEFAULT` pattern
 * in `strategies/shared.ts` — the const documents the default while the env
 * is read per-call so tests can override it without module reload.
 */
export const CHAIN_MAX_HOPS_DEFAULT = 4;

/**
 * Read the effective chain hop cap from env, falling back to `CHAIN_MAX_HOPS_DEFAULT`.
 * Called per `resolveChain` invocation so env-variable test overrides take effect
 * without needing a module reload.
 */
function chainMaxHops(): number {
  const raw = process.env.CODEGRAPH_RB_CHAIN_MAX_HOPS;
  if (raw === undefined) return CHAIN_MAX_HOPS_DEFAULT;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : CHAIN_MAX_HOPS_DEFAULT;
}

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
  return rubyReceiverForm(receiverTypeRef(receiver, atLine, ctx));
}

/** {@link typeOfReceiver}'s lookup, before the receiver-form collapse. */
function receiverTypeRef(receiver: string, atLine: number, ctx: CallContext): RubyTypeRef | undefined {
  // ── Dotted chain: multi-hop threading (Task 1.4) ─────────────────────────
  if (receiver.includes(".")) {
    return resolveChain(receiver, atLine, ctx);
  }

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
 * Thread a dotted chain receiver through the propagation engine.
 *
 * Algorithm:
 * 1. Split `receiver` into `[head, link1, link2, ...]`.
 * 2. Seed: resolve `head` via the single-hop path (recurse into `typeOfReceiver`
 *    without the dot guard).
 * 3. For each link left-to-right: `t = returnTypeOf(t, link, ctx)`.
 *    - First `undefined` hop → STOP, return `undefined` (precision invariant:
 *      never fabricate past an unknown hop).
 * 4. Cap at `CHAIN_MAX_HOPS` hops — a chain longer than the cap returns `undefined`.
 */
function resolveChain(receiver: string, atLine: number, ctx: CallContext): RubyTypeRef | undefined {
  const segments = receiver.split(".");
  // segments[0] is the head; segments[1..] are the member links.
  const head = segments[0];
  if (!head) return undefined;

  const links = segments.slice(1);

  // Hop cap: links.length is the number of hops (each `.link` = one hop).
  if (links.length > chainMaxHops()) return undefined;

  let current: RubyTypeRef | undefined;
  let startLink = 0;
  // Bare-constant head. Two ways the first link can be typed, declared facts FIRST:
  //
  //  1. DECLARED (bd tea-rags-mcp-6zpds) — the project itself states what the
  //     member returns on that constant (`scope :without_deleted` →
  //     `container(Owner)`, a YARD `@return`, an inherited fact). Custom scopes
  //     live only here; the generic vocabulary cannot know them.
  //  2. VOCABULARY (rvw34 gap b) — a framework/Ruby instance-returning verb
  //     (`new`/`find`/`create!`…) makes the chain an instance of the constant:
  //     `PostStatusService.new` is definitionally a PostStatusService.
  //
  // Both are zero-fabrication. A bare-const head that is neither declared nor
  // vocabulary (`Config.value`) is still NOT typed.
  const firstLink = links[0];
  const headMember = firstLink === undefined ? null : stripArgs(firstLink);
  const declaredHead =
    headMember !== null && CONST_HEAD.test(head) ? declaredReturnType(head, headMember, ctx) : undefined;
  if (declaredHead !== undefined) {
    current = declaredHead;
    startLink = 1;
  } else if (
    headMember !== null &&
    CONST_HEAD.test(head) &&
    catalogueForGemfile(ctx.gemfileContent).instanceReturning.has(headMember)
  ) {
    current = { form: "instance", name: head };
    startLink = 1;
  } else {
    // Seed: resolve head via single-hop (no dot in head → no recursion risk).
    current = typeOfReceiver(head, atLine, ctx);
  }
  if (current === undefined) return undefined;

  // Walk remaining links left-to-right, threading type through each hop.
  for (let i = startLink; i < links.length; i++) {
    current = returnTypeOf(current, stripArgs(links[i]), ctx);
    if (current === undefined) return undefined; // STOP-at-unknown-hop
  }

  return current;
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
