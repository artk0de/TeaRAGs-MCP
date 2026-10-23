import { CONTINUE, DROP, resolved } from "../../../../../contracts/resolution.js";
import type { CallContext, CallRef } from "../../../../../contracts/types/codegraph.js";
import type {
  RustCallSiteDefinition,
  SymbolResolutionOutcome,
  SymbolResolutionStrategy,
} from "../../../../../contracts/types/language.js";
import {
  mapScipDefinitionToSymbol,
  rustCallSiteIsDerivedImpl,
  rustcCallSiteDefinitionOf,
  rustScipDefinitionIsExternal,
} from "../scip-resolution.js";
import { rustCallIsMacroInvocation, type ResolverConfig } from "./shared.js";

/**
 * bd s3i8m T7 + RESIDUAL R2 — the rustc call-site driver's type-checked callee
 * for the member token (research/rustc-driver/SPEC.md §8.5) is the AUTHORITY
 * over every static pass: the slot heads the chain. An in-project callable
 * mapped onto one table symbol is the edge (a re-target where a name pass
 * would have bound a namesake); a provably external target DROPs; a derived
 * impl DROPs too — derive output has no table symbol, so no pass may
 * name-match one. Anything else — no index, no position, no row, a macro
 * invocation whose row is no macro row, an unmapped definition — CONTINUEs,
 * and the static chain answers exactly as it did without the driver. An
 * in-project callable no table symbol contains is counted per pass
 * (`inProjectUnmapped`, RESIDUAL R1's gate).
 */
export class RustcCallSiteSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "rustcCallSites";
  /** `relPath:line:col` of every in-project callable row this pass failed to map. */
  private readonly unmappedInProjectSites = new Set<string>();
  // One definition, one table symbol — no ambiguous-mode pick.
  constructor(_cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    const definition = authoritativeDefinitionOf(call, ctx);
    if (definition === null) return CONTINUE;
    const outcome = driverVerdict(definition, call, ctx);
    if (outcome.kind === "continue" && definition.inProject && definition.kind === expectedKindOf(call)) {
      this.unmappedInProjectSites.add(`${ctx.callerFile}:${call.memberStartLine}:${call.memberStartColumn}`);
    }
    return outcome;
  }

  /**
   * Whether the driver's row decides the call so a dispatch fan-out must not
   * replace it: any non-CONTINUE verdict except a trait-body declaration — that
   * row proves the trait, and the cone over its impls refines it.
   */
  overridesDispatch(call: CallRef, ctx: CallContext): boolean {
    const definition = authoritativeDefinitionOf(call, ctx);
    if (definition === null || definition.declaringTrait !== undefined) return false;
    return driverVerdict(definition, call, ctx).kind !== "continue";
  }

  /** Forget the previous pass's counts — the resolver's pass-start seam calls it. */
  beginPass(): void {
    this.unmappedInProjectSites.clear();
  }

  /** In-project callable rows this pass found no table symbol for. */
  unmappedInProjectCount(): number {
    return this.unmappedInProjectSites.size;
  }
}

/** The definition kind a call's row must carry to be its answer: a macro row for `name!`, else a callable. */
function expectedKindOf(call: CallRef): RustCallSiteDefinition["kind"] {
  return rustCallIsMacroInvocation(call) ? "macro" : "callable";
}

/** The driver's row at the member token, unless a macro invocation's row is no macro row (the macro pass owns it). */
function authoritativeDefinitionOf(call: CallRef, ctx: CallContext): RustCallSiteDefinition | null {
  const definition = rustcCallSiteDefinitionOf(call, ctx);
  if (definition === null) return null;
  if (rustCallIsMacroInvocation(call) && definition.kind !== "macro") return null;
  return definition;
}

function driverVerdict(definition: RustCallSiteDefinition, call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
  if (rustCallSiteIsDerivedImpl(definition)) return DROP;
  const edgeTarget = mapScipDefinitionToSymbol(definition, call, ctx);
  if (edgeTarget !== null) return resolved(edgeTarget);
  return rustScipDefinitionIsExternal(definition, call, ctx) ? DROP : CONTINUE;
}
