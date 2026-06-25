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
 * - `@ivar` → `ctx.ivarTypes` (wins, Task 1.5 wires population) or
 *   `ctx.classFieldTypes` (fallback — already populated by the walker today).
 * - Dotted chain receiver (`a.b.c`) → multi-hop threading via {@link returnTypeOf}
 *   seeded from the head segment and walked left-to-right. Capped at
 *   `CODEGRAPH_RB_CHAIN_MAX_HOPS` (default 4).
 * - Constants / `self` / `super` / index-access → `undefined`.
 *
 * **Not wired.** No resolver/strategy/walker imports this module yet — that is
 * Task 1.5. The full ruby resolver suite stays GREEN unchanged.
 */

import { resolveLocalBinding, type CallContext } from "../../../../contracts/types/codegraph.js";
import type { RubyTypeRef } from "../../../../contracts/types/language.js";

/** `@ivar` — a single leading `@` followed by word characters only. */
const IVAR_RECEIVER = /^@\w+$/;

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
 *          index-access, unbound variables, or chains with an unknown hop).
 */
export function typeOfReceiver(receiver: string, atLine: number, ctx: CallContext): RubyTypeRef | undefined {
  // ── Dotted chain: multi-hop threading (Task 1.4) ─────────────────────────
  if (receiver.includes(".")) {
    return resolveChain(receiver, atLine, ctx);
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
  // (`arr[0]`) contains `[` which is not a word character: `resolveLocalBinding`
  // returns `undefined` for them too. The explicit chain guard above is the only
  // structural guard needed.
  const binding = resolveLocalBinding(ctx.localBindings, receiver, atLine);
  if (!binding) return undefined;

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

  // Seed: resolve head via single-hop (no dot in head → no recursion risk).
  let current: RubyTypeRef | undefined = typeOfReceiver(head, atLine, ctx);
  if (current === undefined) return undefined;

  // Walk left-to-right, threading type through each hop.
  for (const link of links) {
    current = returnTypeOf(current, link, ctx);
    if (current === undefined) return undefined; // STOP-at-unknown-hop
  }

  return current;
}

/**
 * Resolve the return type of calling `member` on a receiver of type `recv`.
 *
 * Resolution order (first non-undefined wins):
 * 1. `ctx.structuredReturnTypes?.["${recv.name}#${member}"]` — precise structured ref.
 * 2. `ctx.associationTypes?.[recv.name]?.[member]` → `{form:"instance", name}` —
 *    Rails belongs_to / has_many / has_one DSL associations.
 * 3. Ancestor MRO: walk `ctx.classAncestors?.[recv.name]` for an inherited
 *    `structuredReturnTypes["${ancestor}#${member}"]`.
 * 4. `ctx.functionReturnTypes?.[member]` → `{form:"instance", name}` — flat
 *    fallback (YARD @return map, already populated today). Applied LAST so the
 *    more-precise paths win when available.
 *
 * Union / container forms are NOT threaded here (Task 1.6/1.7) — returns `undefined`.
 */
function returnTypeOf(recv: RubyTypeRef, member: string, ctx: CallContext): RubyTypeRef | undefined {
  // Only class/instance forms are threadable; union/container deferred to later tasks.
  if (recv.form !== "class" && recv.form !== "instance") return undefined;

  // 1. Precise structured return type for this class#member key.
  const key = `${recv.name}#${member}`;
  const direct = ctx.structuredReturnTypes?.[key];
  if (direct !== undefined) return direct;

  // 2. Rails association DSL: associationTypes[className][accessorName] → modelName.
  const assocName = ctx.associationTypes?.[recv.name]?.[member];
  if (assocName !== undefined) return { form: "instance", name: assocName };

  // 3. Ancestor MRO: walk classAncestors[recv.name] for an inherited return type.
  for (const ancestor of ctx.classAncestors?.[recv.name] ?? []) {
    const inherited = ctx.structuredReturnTypes?.[`${ancestor}#${member}`];
    if (inherited !== undefined) return inherited;
  }

  // 4. Flat functionReturnTypes fallback — YARD @return map, populated today.
  const flatName = ctx.functionReturnTypes?.[member];
  if (flatName !== undefined) return { form: "instance", name: flatName };

  return undefined;
}

/**
 * Resolve `@ivar` to its type via `ctx.ivarTypes` (wins when present) or the
 * fallback `ctx.classFieldTypes` (already populated by the walker). The
 * enclosing-class key is `ctx.callerScope.join("::")`, mirroring
 * {@link RubyIvarFieldSymbolResolutionStrategy} — the same key that
 * `collectRubyClassAncestors` / `collectRubyIvarFieldTypes` produce.
 */
function resolveIvarType(ivar: string, ctx: CallContext): RubyTypeRef | undefined {
  if (ctx.callerScope.length === 0) return undefined;
  const scopeKey = ctx.callerScope.join("::");

  // ivarTypes wins over classFieldTypes (richer source; Task 1.4/1.5 wires population)
  const fromIvarTypes = ctx.ivarTypes?.[scopeKey]?.[ivar];
  if (fromIvarTypes !== undefined) return { form: "instance", name: fromIvarTypes };

  const fromFieldTypes = ctx.classFieldTypes?.[scopeKey]?.[ivar];
  if (fromFieldTypes !== undefined) return { form: "instance", name: fromFieldTypes };

  return undefined;
}
