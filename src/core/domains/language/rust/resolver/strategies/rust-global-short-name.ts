import { CONTINUE, DROP, resolved } from "../../../../../contracts/resolution.js";
import { pickSingleCandidate, type CallContext, type CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { rustStdNameBindsByNameOnly } from "../std-name-only-binding.js";
import { rustCalleeShortNameCandidates, type ResolverConfig } from "./shared.js";

/**
 * Terminal global short-name fallback — the Rust-filtered callee-role
 * short-name candidates, then pick the sole one (strict mode) or the first
 * (legacy `first` mode). This is the last pass in the chain; a non-decisive
 * result (no candidates, or ambiguous under strict mode) continues and the
 * chain exhausts to `null`.
 *
 * The lookup goes through the language-filtered helper
 * (`.claude/rules/resolver-architecture.md` §2): the table is polyglot, so a
 * foreign namesake used to trip the single-candidate gate, and the callee
 * role (bd tea-rags-mcp-jqvbn) keeps a trait, enum, type alias or constant
 * sharing the member's name from counting as a callable candidate.
 *
 * A std-prelude name with no receiver-type evidence where the rustc driver is
 * silent DROPS instead (RESIDUAL R5): `x.unwrap()` is `Result::unwrap`, not
 * the corpus's lone `Res#unwrap`.
 */
export class RustGlobalShortNameSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "globalShortName";
  constructor(private readonly cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (rustStdNameBindsByNameOnly(call, ctx)) return DROP;
    const fallback = rustCalleeShortNameCandidates(ctx, call.member);
    const target = pickSingleCandidate(fallback, this.cfg.mode);
    if (target) return resolved({ targetRelPath: target.relPath, targetSymbolId: target.symbolId });
    return CONTINUE;
  }
}
