/**
 * The type of a receiver the walker never BOUND — no `localBindings` entry, no
 * `@ivar` field type, just a bare lowercase identifier at a call site.
 *
 * Ruby has no implicit local declaration, so such an identifier is not a
 * variable the walker missed; it is either a zero-argument method call on `self`
 * ({@link nullaryReceiverType}) or a name that states its own class by
 * convention ({@link conventionReceiverType}). Three tiers, strongest first:
 *
 *  1. a DECLARED return fact on the caller's own MRO (`selfMemberReturnType`);
 *  2. a framework SCOPED reader — devise's `current_user` is a `User`
 *     (bd tea-rags-mcp-adx5p.9), gem-gated by the catalogue;
 *  3. the GENERAL Rails naming convention — `payment` is a `Payment`
 *     (bd tea-rags-mcp-wob7g), gated on the class existing and having no subtypes.
 *
 * Tiers 1–2 compose into {@link nullaryReceiverType}, which `typeOfReceiver`
 * consults. Tier 3 is deliberately NOT wired into `typeOfReceiver` — see
 * {@link conventionReceiverType}. Both are re-exported by `type-propagation.ts`,
 * which stays the address consumers import from.
 *
 * Split out of `type-propagation.ts` (bd tea-rags-mcp-uetqq); every gate and the
 * tier order are unchanged.
 */

import type { CallContext } from "../../../../contracts/types/codegraph.js";
import type { RubyTypeRef } from "../../../../contracts/types/language.js";
import { catalogueForGemfile } from "../gemfile.js";
import { selfMemberReturnType } from "./ruby-return-facts.js";

/**
 * A plain lowercase identifier — the only receiver text that can name a nullary
 * method call. `self` / `super` are keywords the engine already answers
 * `undefined` for and must not be looked up as members.
 */
const NULLARY_RECEIVER = /^[a-z_]\w*[?!]?$/;
const RECEIVER_KEYWORDS = new Set(["self", "super", "nil", "true", "false", "__method__"]);

/**
 * The type of a receiver that is a bare NULLARY method call on self
 * (bd tea-rags-mcp-pr7fu) — `current_client` in `current_client.foo`.
 *
 * Ruby has no implicit local declaration, so an identifier the walker never
 * bound and that appears in receiver position cannot be a variable: it is a
 * zero-argument method resolved on `self` or an ancestor. That makes its return
 * fact exactly as authoritative for the receiver's type as a local binding is,
 * and it reaches the same census bucket the local-binding channel already
 * covers for `x = current_client()` — the only difference is that the result was
 * never assigned to a name.
 *
 * Gated by {@link selfMemberReturnType}: the caller's own class answers, or its
 * ancestors must agree. No fact, or a disagreement, yields `undefined` and the
 * receiver stays untyped exactly as before.
 */
export function nullaryReceiverType(receiver: string, ctx: CallContext): RubyTypeRef | undefined {
  if (RECEIVER_KEYWORDS.has(receiver) || !NULLARY_RECEIVER.test(receiver)) return undefined;
  return selfMemberReturnType(receiver, ctx) ?? scopedReceiverType(receiver, ctx);
}

/** `blog_post` → `BlogPost`: upcase each `_`-separated segment (Rails camelize). */
function camelizeScope(snake: string): string {
  return snake
    .split("_")
    .filter((s) => s.length > 0)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
}

/**
 * The class a snake_case identifier NAMES by Rails convention, or `undefined`
 * when the run declares no such class.
 *
 * The existence gate is the whole precision story of both convention tiers: an
 * identifier that camelizes to a name nothing declares means something else
 * entirely, and a fabricated receiver type poisons every downstream hop. Shared
 * so {@link scopedReceiverType} (devise's `current_<scope>`) and the general
 * tier {@link conventionReceiverType} cannot drift apart on what "the class
 * exists" means.
 */
function conventionClassName(snake: string, ctx: CallContext): string | undefined {
  const name = camelizeScope(snake);
  return name.length > 0 && ctx.symbolTable.lookupByShortName(name).length > 0 ? name : undefined;
}

/**
 * The type a framework SCOPED receiver carries by naming convention
 * (bd tea-rags-mcp-adx5p.9) — devise's `current_user` is a `User`.
 *
 * The framework defines one such method per declared scope at runtime, so no
 * file declares it and every fact channel {@link selfMemberReturnType} consults
 * is empty by construction. The catalogue's `instanceReceiverPrefixes` facet
 * states the convention; which prefixes exist is gem-gated, so a project without
 * the gem gets none and its own `current_*` method is untouched.
 *
 * Two further precision gates, both of which resolve to silence:
 *  - a DECLARED fact wins — this runs only after `selfMemberReturnType` misses,
 *    so an app whose `current_user` returns an impersonation keeps that type;
 *  - the derived class must EXIST in the run's symbol table. `current_tenant` in
 *    an app with no `Tenant` names something else entirely, and a fabricated
 *    receiver type poisons every downstream hop.
 */
function scopedReceiverType(receiver: string, ctx: CallContext): RubyTypeRef | undefined {
  for (const prefix of catalogueForGemfile(ctx.gemfileContent).instanceReceiverPrefixes) {
    if (!receiver.startsWith(prefix) || receiver.length === prefix.length) continue;
    const name = conventionClassName(receiver.slice(prefix.length), ctx);
    if (name !== undefined) return { form: "instance", name };
  }
  return undefined;
}

/**
 * A bare or `@`/`@@`-prefixed lowercase identifier — the whole surface the
 * general convention tier acts on. Deliberately narrower than
 * {@link NULLARY_RECEIVER}: no `?`/`!` suffix (a predicate call is not a
 * variable named for its class) and no uppercase (a constant is
 * `RubyConstantSymbolResolutionStrategy`'s case).
 */
const CONVENTION_RECEIVER = /^@{0,2}[a-z_][a-z0-9_]*$/;

/**
 * Receiver texts that are keywords or block placeholders, never a variable
 * named after its class. Ruby 3.4's implicit block parameter `it` and the
 * conventional throwaway `_` join the reserved words — an app that happens to
 * declare an `It` must not have `it.foo` typed as one.
 */
const CONVENTION_RECEIVER_KEYWORDS = new Set([...RECEIVER_KEYWORDS, "it", "_"]);

/**
 * Does this class have SUBTYPES? A class with descendants is a polymorphic
 * base, and a variable named after it carries a CONCRETE subtype at runtime —
 * `actor` in a Rails app whose `Actor` is specialised by System / Guest / User
 * / Employee is an `Employee`, not an `Actor`. Guessing the base fabricates an
 * edge to a method the receiver may never run.
 *
 * That shape is not a hypothesis: on taxdome it is where EVERY measured
 * convention error came from, and gating on it is what makes this tier
 * shippable at all (bd tea-rags-mcp-wob7g).
 *
 * The hierarchy snapshot is keyed by the ancestor text as WRITTEN in the
 * subclass header, so both the bare name and every fully-qualified declaration
 * carrying that short name are asked. No snapshot (a resolver constructed
 * without one) means no evidence of subtypes, and the convention proceeds —
 * the caller has already gated on the class existing.
 */
function hasDeclaredSubtypes(name: string, ctx: CallContext): boolean {
  const { hierarchy } = ctx;
  if (hierarchy === undefined) return false;
  if (hierarchy.getDescendants(name).length > 0) return true;
  for (const def of ctx.symbolTable.lookupByShortName(name)) {
    if (def.fqName !== name && hierarchy.getDescendants(def.fqName).length > 0) return true;
  }
  return false;
}

/**
 * The type a receiver carries by the GENERAL Rails naming convention
 * (bd tea-rags-mcp-wob7g) — `payment` is a `Payment`, `@recurring_invoice` a
 * `RecurringInvoice`.
 *
 * This is {@link scopedReceiverType} with the `current_*` prefix requirement
 * removed. The convention devise's `current_user` relies on is not a devise
 * convention at all; it is the dominant naming discipline of the language, and
 * on taxdome it names the receiver of 11% of the entire recall hole.
 *
 * Two gates, both measured rather than argued:
 *  - the class must EXIST in the run ({@link conventionClassName});
 *  - it must have NO subtypes ({@link hasDeclaredSubtypes}) — see there.
 *
 * **Deliberately NOT wired into `typeOfReceiver`.** A guess is weaker
 * evidence than a fact, and `typeOfReceiver` is read by consumers that treat
 * its answer as one: `chainType` turns a typed receiver whose class declares no
 * such member into a FILE-ONLY edge (`targetSymbolId: null` — invisible to
 * `get_callers`, and it inflates fan-in on the biggest models in the app), and
 * the dynamic component's typed-receiver deferral (bd tea-rags-mcp-55950) would
 * silently drop the fan-out on the strength of it. The convention is therefore
 * consumed by ONE strategy, `conventionReceiver`, which sits after every fact
 * channel and demands a method-level target.
 */
export function conventionReceiverType(receiver: string, ctx: CallContext): RubyTypeRef | undefined {
  if (!CONVENTION_RECEIVER.test(receiver)) return undefined;
  const bare = receiver.replace(/^@{1,2}/, "");
  if (CONVENTION_RECEIVER_KEYWORDS.has(bare)) return undefined;
  const name = conventionClassName(bare, ctx);
  if (name === undefined || hasDeclaredSubtypes(name, ctx)) return undefined;
  return { form: "instance", name };
}
