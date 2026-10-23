import { CONTINUE, DROP, resolved } from "../../../../../contracts/resolution.js";
import type { CallContext, CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import {
  mapScipDefinitionToSymbol,
  rustCallSiteIsDerivedImpl,
  rustcCallSiteDefinitionOf,
  rustScipDefinitionIsExternal,
} from "../scip-resolution.js";
import type { ResolverConfig } from "./shared.js";

/**
 * bd s3i8m T7 — after every name pass, before the SCIP slot, ask the rustc
 * call-site driver what the member token names: the type-checked callee
 * (research/rustc-driver/SPEC.md §8.5). It sees only the sites every earlier
 * pass CONTINUEd on, so it never overrides an edge. An in-project callable
 * mapped onto one table symbol is an edge; a provably external target DROPs;
 * a derived impl DROPs too — derive output has no table symbol, so no later
 * pass may name-match one. Anything else — no index, no position, no row, an
 * unmapped definition — CONTINUEs, and the SCIP slot still gets the site.
 */
export class RustcCallSiteSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "rustcCallSites";
  // One definition, one table symbol — no ambiguous-mode pick.
  constructor(_cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    const definition = rustcCallSiteDefinitionOf(call, ctx);
    if (definition === null) return CONTINUE;
    if (rustCallSiteIsDerivedImpl(definition)) return DROP;
    const edgeTarget = mapScipDefinitionToSymbol(definition, call, ctx);
    if (edgeTarget !== null) return resolved(edgeTarget);
    return rustScipDefinitionIsExternal(definition, call, ctx) ? DROP : CONTINUE;
  }
}
