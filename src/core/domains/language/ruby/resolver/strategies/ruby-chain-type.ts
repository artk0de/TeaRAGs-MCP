import { CONTINUE, DROP, resolved } from "../../../../../contracts/resolution.js";
import type { CallContext, CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { typeOfReceiver } from "../type-propagation.js";
import { resolveTypeInstanceMethod, resolveTypeStaticMethod, type ResolverConfig } from "./shared.js";

/**
 * Dotted-chain receiver resolution via the type-propagation engine (Increment 1,
 * Task 1.5). Engages ONLY when `call.receiver` is a multi-segment dotted chain
 * (contains `.`); single-segment receivers (`user`, `@client`) are already owned
 * by the `localType` and `ivarField` passes and must CONTINUE here so they fall
 * through to those earlier (already-tried) handlers normally.
 *
 * **Three-state semantics:**
 *
 * - `CONTINUE` — the chain type is unknown (no seed data for the head, or an
 *   intermediate hop lacks a structuredReturnType / associationType entry).
 *   The existing `receiverSetDrop` guard catches these calls next, preserving
 *   the pre-Task-1.5 behaviour exactly (CONTINUE → receiverSetDrop → DROP).
 *
 * - `resolved(target)` — the engine resolved the terminal type to an in-project
 *   class; `resolveTypeInstanceMethod` / `resolveTypeStaticMethod` found a
 *   match. Terminal: this call never fans out to dynamic short-name guesses.
 *
 * - `DROP` — the terminal type is known but the class's file is NOT in the
 *   project symbol table (gem / stdlib). Mirrors the `localType` and `ivarField`
 *   precision discipline: a known type miss DROPS rather than fabricating.
 *
 * **Chain placement:**
 * Inserted AFTER `returnTypeBinding` and BEFORE `arRelationGuard` / `receiverSetDrop`.
 * The single-var passes (`localType`, `ivarField`, `returnTypeBinding`) own
 * single-segment receivers and exit early (no `.` in their receiver paths).
 * `chainType` runs on the remaining multi-segment chains; those not resolved
 * here fall to `arRelationGuard` (AR-specific chain guard) then `receiverSetDrop`
 * (catch-all unknown-receiver DROP), preserving the pre-increment behaviour.
 */
export class RubyChainTypeSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "chainType";
  constructor(private readonly cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    const r = call.receiver;
    // Only multi-segment dotted chains. Single-segment receivers (`user`,
    // `@client`) are already owned by localType / ivarField; returning CONTINUE
    // here lets them reach those earlier passes unchanged (the chain runs from
    // top — this is called after them, so a single-var hit would have already
    // returned resolved/drop before reaching this strategy).
    if (!r?.includes(".")) return CONTINUE;

    const t = typeOfReceiver(r, call.startLine, ctx);
    // Unknown or union/container form — let existing passes handle (CONTINUE).
    if (!t || (t.form !== "class" && t.form !== "instance")) return CONTINUE;

    const resolve = t.form === "class" ? resolveTypeStaticMethod : resolveTypeInstanceMethod;
    const target = resolve(t.name, call.member, ctx, this.cfg.mode);
    return target ? resolved(target) : DROP;
  }
}
