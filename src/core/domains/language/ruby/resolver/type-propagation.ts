/**
 * Ruby receiver type-propagation engine — single-hop parity (Increment 1, Task 1.3).
 *
 * Exposes {@link typeOfReceiver}: given a raw receiver string + call line + the
 * per-file {@link CallContext}, resolves the static {@link RubyTypeRef} for
 * single-hop receivers (local variable bindings and `@ivar` field types).
 *
 * **Scope of this module:**
 * - Local variable → `LocalBinding` via `resolveLocalBinding` → `RubyTypeRef`.
 * - `@ivar` → `ctx.ivarTypes` (wins, Task 1.4/1.5 wires population) or
 *   `ctx.classFieldTypes` (fallback — already populated by the walker today).
 * - Dotted chain receiver (`a.b`) → `undefined` (Task 1.4 adds threading).
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
 * Resolve the static {@link RubyTypeRef} for a single-hop receiver.
 *
 * @param receiver - Raw receiver text from the call site (e.g. `"user"`, `"@client"`, `"a.b"`).
 * @param atLine   - 1-based source line of the call; used for position-aware
 *                   local-binding lookup (`LocalBinding.line <= atLine`).
 * @param ctx      - Per-call {@link CallContext} carrying `localBindings`,
 *                   `ivarTypes`, `classFieldTypes`, and `callerScope`.
 * @returns A {@link RubyTypeRef} when the receiver's static type is known;
 *          `undefined` for unknowable receivers (chains, constants, self, super,
 *          index-access, unbound variables).
 */
export function typeOfReceiver(receiver: string, atLine: number, ctx: CallContext): RubyTypeRef | undefined {
  // ── Dotted chain: deferred to Task 1.4 ──────────────────────────────────
  if (receiver.includes(".")) return undefined;

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

  return {
    form: binding.valueKind === "class" ? "class" : "instance",
    name: binding.type,
  };
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
