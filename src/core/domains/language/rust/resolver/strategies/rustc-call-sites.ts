import { CONTINUE, DROP, resolved } from "../../../../../contracts/resolution.js";
import type { CallContext, CallRef } from "../../../../../contracts/types/codegraph.js";
import type {
  RustCallSiteDefinition,
  SymbolResolutionOutcome,
  SymbolResolutionStrategy,
} from "../../../../../contracts/types/language.js";
import {
  mapRustCallSiteDefinitionToSymbol,
  mapRustGeneratedTraitImplToDeclaration,
  mapRustGeneratingMacroToSymbol,
  rustCallSiteDefinitionIsExternal,
  rustCallSiteIsDerivedImpl,
  rustCallSiteIsForeignGenerated,
  rustcCallSiteDefinitionOf,
} from "../call-site-resolution.js";
import { rustCallIsMacroInvocation, type ResolverConfig } from "./shared.js";

/**
 * bd s3i8m T7 + RESIDUAL R2 — the rustc call-site driver's type-checked callee
 * for the member token (research/rustc-driver/SPEC.md §8.5) is the AUTHORITY
 * over every static pass: the slot heads the chain. An in-project callable
 * mapped onto one table symbol is the edge (a re-target where a name pass
 * would have bound a namesake); a provably external target DROPs; a derived
 * impl DROPs too — derive output has no table symbol, so no pass may
 * name-match one — and so does a closure / fn pointer / Fn-bound param callee
 * (RESIDUAL R4, counted per pass as `localCallee`). A definition a macro
 * GENERATED (format 4 `defExpansion`) has no source symbol of its name either:
 * a dependency macro's output DROPs as external, a project macro's callable is
 * the edge to the project trait method it implements, else to that macro's own
 * table symbol, or DROPs when neither maps —
 * never a namesake (counted as `generated` / `generatedUnmapped`). Anything
 * else — no index, no position, no row, a macro invocation whose row is no
 * macro row, an unmapped definition — CONTINUEs,
 * and the static chain answers exactly as it did without the driver. An
 * in-project callable no table symbol contains is counted per pass
 * (`inProjectUnmapped`, RESIDUAL R1's gate).
 */
export class RustcCallSiteSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "rustcCallSites";
  /** `relPath:line:col` of every in-project callable row this pass failed to map. */
  private readonly unmappedInProjectSites = new Set<string>();
  /** `relPath:line:col` of every closure / fn pointer / Fn-bound param callee row this pass dropped (RESIDUAL R4). */
  private readonly localCalleeSites = new Set<string>();
  /** `relPath:line:col` of every macro-generated definition row this pass decided. */
  private readonly generatedSites = new Set<string>();
  /** `relPath:line:col` of every project-macro-generated row whose macro mapped to no table symbol. */
  private readonly generatedUnmappedSites = new Set<string>();
  // One definition, one table symbol — no ambiguous-mode pick.
  constructor(_cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    const definition = authoritativeDefinitionOf(call, ctx);
    if (definition === null) return CONTINUE;
    const outcome = driverVerdict(definition, call, ctx);
    const site = `${ctx.callerFile}:${call.memberStartLine}:${call.memberStartColumn}`;
    if (outcome.kind === "continue" && definition.inProject && definition.kind === expectedKindOf(call)) {
      this.unmappedInProjectSites.add(site);
    }
    if (definition.indirectCallee !== undefined) this.localCalleeSites.add(site);
    if (decidedAsGenerated(definition)) {
      this.generatedSites.add(site);
      if (outcome.kind === "drop" && !rustCallSiteIsForeignGenerated(definition)) this.generatedUnmappedSites.add(site);
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
    this.localCalleeSites.clear();
    this.generatedSites.clear();
    this.generatedUnmappedSites.clear();
  }

  /** In-project callable rows this pass found no table symbol for. */
  unmappedInProjectCount(): number {
    return this.unmappedInProjectSites.size;
  }

  /** Closure / fn pointer / Fn-bound param callee rows this pass dropped. */
  localCalleeCount(): number {
    return this.localCalleeSites.size;
  }

  /** Macro-generated definition rows this pass decided (dropped or edged to their macro). */
  generatedCount(): number {
    return this.generatedSites.size;
  }

  /** Project-macro-generated rows this pass dropped because the macro mapped to no table symbol. */
  generatedUnmappedCount(): number {
    return this.generatedUnmappedSites.size;
  }
}

/**
 * Whether the row is decided by the macro that generated its definition: any
 * definition a dependency macro wrote, and a project macro's callable — a
 * project macro's type stays with the static chain, as before format 4.
 */
function decidedAsGenerated(definition: RustCallSiteDefinition): boolean {
  if (definition.defExpansion === undefined) return false;
  return rustCallSiteIsForeignGenerated(definition) || definition.kind === "callable";
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
  // A closure / fn pointer / Fn-bound param callee (RESIDUAL R4) has no table
  // symbol either: a name pass could only bind a namesake.
  if (rustCallSiteIsDerivedImpl(definition) || definition.indirectCallee !== undefined) return DROP;
  if (decidedAsGenerated(definition)) {
    if (rustCallSiteIsForeignGenerated(definition)) return DROP;
    const target =
      mapRustGeneratedTraitImplToDeclaration(definition, ctx) ?? mapRustGeneratingMacroToSymbol(definition, ctx);
    return target === null ? DROP : resolved(target);
  }
  const edgeTarget = mapRustCallSiteDefinitionToSymbol(definition, call, ctx);
  if (edgeTarget !== null) return resolved(edgeTarget);
  return rustCallSiteDefinitionIsExternal(definition, call, ctx) ? DROP : CONTINUE;
}
