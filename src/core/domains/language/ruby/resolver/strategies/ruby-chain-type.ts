import { ChainTypeSymbolResolutionStrategy, type ReceiverTypingPorts } from "../../../kernel/index.js";
import { createRubyTypeMemberLookup } from "../ruby-type-member-lookup.js";
import { typeOfReceiver } from "../type-propagation.js";
import type { ResolverConfig } from "./shared.js";

/**
 * Ruby's chain-fold typing: any receiver the propagation engine can type — a
 * dotted chain, an index access (`arr[0]` — already unwrapped container →
 * element), a bare identifier a return fact or a framework naming convention
 * types. Unknown answers `null`; a union or container form reaches the kernel,
 * which CONTINUEs on it.
 */
const RUBY_CHAIN_TYPE_TYPING: ReceiverTypingPorts = {
  typeOfReceiver: (call, ctx) => typeOfReceiver(call.receiver, call.startLine, ctx) ?? null,
};

/**
 * Typed-receiver resolution via the type-propagation engine (Increment 1,
 * Task 1.5). The entry condition is TYPEDNESS, not receiver shape: whatever
 * `typeOfReceiver` threads to a single class or instance, this pass resolves the
 * member on.
 *
 * It used to also require a dot or an index access, on the stated assumption
 * that "single-segment receivers (`user`, `@client`) are already owned by the
 * `localType` and `ivarField` passes". Two channels landed afterwards that type
 * a BARE identifier owned by NEITHER — `nullaryReceiverType` (bd
 * tea-rags-mcp-pr7fu: an unbound lowercase identifier in receiver position is a
 * zero-arg self-call, so its return fact types the receiver) and
 * `scopedReceiverType` (bd tea-rags-mcp-adx5p.9: the devise `current_<scope>`
 * convention). `localType` needs a `localBindings` entry those receivers do not
 * have and `ivarField` needs a `@`, so both CONTINUE, and the shape test threw
 * away a type the engine had already computed (bd tea-rags-mcp-e8feo, increment
 * 0 of docs/superpowers/specs/2026-08-02-barrier-const-chain-typing-design.md).
 *
 * **Three-state semantics:**
 *
 * - `CONTINUE` — the receiver type is unknown (no seed data for the head, an
 *   intermediate hop lacks a structuredReturnType / associationType entry, or
 *   the type is a union / container with no single class to look up). The
 *   existing `receiverSetDrop` guard catches these calls next, preserving the
 *   pre-Task-1.5 behaviour exactly (CONTINUE → receiverSetDrop → DROP).
 *
 * - `resolved(target)` — the engine resolved the terminal type to an in-project
 *   class; `resolveTypeInstanceMethod` / `resolveTypeStaticMethod` found a
 *   match. Terminal: this call never fans out to dynamic short-name guesses.
 *
 * - `DROP` — the terminal type is known but the class's file is NOT in the
 *   project symbol table (gem / stdlib). Mirrors the `localType` and `ivarField`
 *   precision discipline: a known type miss DROPS rather than fabricating.
 *
 * Widening the entry condition widens what can DROP, so the DROP surface was
 * measured before the change (`CODEGRAPH_SINGLESEG_ORACLE=1` in
 * `scripts/taxdome-codegraph-recall-forensics.ts`). On taxdome the widened guard
 * fires at 10 094 of 107 292 single-segment receiver sites, 2 449 of them DROP,
 * and NOT ONE call loses a resolution or changes target. That is structural
 * rather than lucky: the only passes after this one are `arRelationGuard` (which
 * needs a dot in the receiver text) and `receiverSetDrop` (which DROPs every
 * receiver-set call), so a single-segment receiver that CONTINUEs from here
 * reaches `null` anyway — DROP and CONTINUE are the same answer for it, and DROP
 * is the one the sibling typed-receiver guards already give.
 *
 * **Chain placement:**
 * Inserted AFTER `returnTypeBinding` and BEFORE `arRelationGuard` / `receiverSetDrop`.
 * The single-var passes (`localType`, `ivarField`, `returnTypeBinding`) are
 * terminal for the receivers they own — a local binding, an `@ivar`, a
 * call-bound name — so anything reaching here was declined by all three. Calls
 * not resolved here fall to `arRelationGuard` (AR-specific chain guard) then
 * `receiverSetDrop` (catch-all unknown-receiver DROP), preserving the
 * pre-increment behaviour.
 *
 * The verdict is the kernel's `ChainTypeSymbolResolutionStrategy` (bd
 * tea-rags-mcp-m99j1.1.5); this class binds Ruby's typing port, Ruby's
 * `TypeMemberLookup` (`class` form → static, `instance` → instance method) and
 * the DROP-on-typed-miss policy above.
 */
export class RubyChainTypeSymbolResolutionStrategy extends ChainTypeSymbolResolutionStrategy {
  constructor(cfg: ResolverConfig) {
    super("chainType", RUBY_CHAIN_TYPE_TYPING, createRubyTypeMemberLookup(cfg.mode), { dropOnTypedMiss: true });
  }
}
