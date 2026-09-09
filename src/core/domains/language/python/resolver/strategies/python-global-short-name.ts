import { CONTINUE, resolved } from "../../../../../contracts/resolution.js";
import { pickSingleCandidate, type CallContext, type CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import type { ResolverConfig } from "./shared.js";

/**
 * Global short-name fallback — the LAST strategy in the chain, and now a guess
 * that is only allowed to speak about calls whose enclosing scope really owns
 * the member (bd tea-rags-mcp-99t5y).
 *
 * A member name is evidence about what is CALLED. It says nothing about what it
 * is called ON, so on a receiver-bound call `lookupByShortName(member)` answers
 * with whatever unrelated project class happens to spell that member — a
 * fabricated edge, not a weak one. The seeded oracle separates the two families
 * cleanly (match / phantom, per receiverKind):
 *
 *   - in credit — `bareCall` netbox 441/0, polar 3259/80, ugnest 129/0;
 *     `selfMember` netbox 756/40, polar 1284/3. The call names a function the
 *     module or the enclosing class owns, and the short name IS the evidence.
 *   - in deficit — `chain` ugnest 0/124, polar 69/567, netbox 142/175;
 *     `dynamic` ugnest 1/17, polar 357/547, netbox 42/89; plus `index`,
 *     `localVar` and `constant`, each losing on every corpus that has them.
 *
 * So the receiver decides. `bareCall` and `selfMember` reach the table;
 * everything else CONTINUEs — never DROP, because the typed passes above have
 * already had their say and refusing on their behalf would suppress work they
 * park. As the last strategy, a CONTINUE here exhausts to `null`, which is the
 * original terminal `return null`.
 *
 * The gate reads `call.receiver` directly rather than importing the trajectory's
 * `classifyReceiverKind`: `language` is a leaf domain and may not import a
 * sibling (`.claude/rules/domain-boundaries.md`). Nothing is re-implemented —
 * the two kinds admitted here are the classifier's two UNCONDITIONAL ones,
 * `receiver === null` for `bareCall` and `receiver === "self"` for
 * `selfMember`, neither of which consults localBindings or any pattern. Every
 * kind the classifier decides by inspecting receiver TEXT is on the other side
 * of the gate, so the two cannot drift apart.
 *
 * `constant` left the guess list rather than the chain: `Cls.method()` on a
 * class the calling file declares is now resolved from the symbol table by
 * `importedName`'s same-file class arm, on the receiver's own evidence.
 */
export class PythonGlobalShortNameSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "globalShortName";
  constructor(private readonly cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (call.receiver !== null && call.receiver !== "self") return CONTINUE;
    const fallback = ctx.symbolTable.lookupByShortName(call.member);
    const hit = pickSingleCandidate(fallback, this.cfg.mode);
    if (hit) return resolved({ targetRelPath: hit.relPath, targetSymbolId: hit.symbolId });
    return CONTINUE;
  }
}
