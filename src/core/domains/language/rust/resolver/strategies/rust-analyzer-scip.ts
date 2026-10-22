import { CONTINUE, DROP, resolved } from "../../../../../contracts/resolution.js";
import type { CallContext, CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { mapScipDefinitionToSymbol, rustScipDefinitionIsExternal, rustScipDefinitionOf } from "../scip-resolution.js";
import type { ResolverConfig } from "./shared.js";

/**
 * bd s3i8m.6 R3a — the chain's last slot asks the rust-analyzer SCIP index
 * what the member token names. No Rust pass defers, so this slot sees exactly
 * the sites every earlier pass CONTINUEd on: it never overrides an edge and
 * never re-asks a DROPped site. An in-project callable mapped onto one table
 * symbol is an edge; a provably external target DROPs (no edge exists —
 * equivalent to CONTINUE while last, correct if a pass is ever appended);
 * anything else — no index, no position, no occurrence, a local, a type, an
 * unmapped definition — CONTINUEs and leaves the site as it was.
 */
export class RustAnalyzerScipSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "rustAnalyzerScip";
  // One definition, one table symbol — no ambiguous-mode pick.
  constructor(_cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    const definition = rustScipDefinitionOf(call, ctx);
    if (definition === null) return CONTINUE;
    const edgeTarget = mapScipDefinitionToSymbol(definition, call, ctx);
    if (edgeTarget !== null) return resolved(edgeTarget);
    return rustScipDefinitionIsExternal(definition, ctx) ? DROP : CONTINUE;
  }
}
