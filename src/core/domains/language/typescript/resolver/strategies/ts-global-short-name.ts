import { CONTINUE, resolved } from "../../../../../contracts/resolution.js";
import { pickSingleCandidate, type CallContext, type CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { targetsExternalImport } from "../ts-external-call.js";
import { calleeIsLocalValueBinding } from "../ts-local-callee.js";
import { receiverIsUnpinnableLocalValueBinding } from "../ts-local-receiver.js";
import type { TSProgramCache } from "../ts-program-cache.js";
import type { ResolverConfig } from "./shared.js";

/**
 * Global short-name lookup — handles default exports, ambient declarations, and
 * free calls. `pickSingleCandidate(mode)` returns the sole hit (strict) or the
 * first hit (legacy `first` mode). On a non-decisive result (no candidates, or
 * ambiguous under strict mode) continue to the import-narrowed fallback.
 *
 * The lookup key is a BARE member name, which is what makes the external guard
 * load-bearing rather than a nicety (bd tea-rags-mcp-6b3gj): `arr.push()` and
 * `console.error()` carry a member that some project symbol is very likely to
 * share, and matching it here emits an edge to code the call never reaches.
 * A call that provably leaves the project CONTINUEs instead — the later
 * type-checker passes still get their turn, and a call none of them can answer
 * ends up correctly classified external rather than silently fabricated.
 *
 * A BARE call needs a second guard, because every arm of the external one
 * inspects a receiver and a free call has none (bd tea-rags-mcp-5tatv). There
 * the member IS the callee identifier, so `onRemove(attachment)` matched an
 * unrelated `Tooltip#onRemove` — see {@link calleeIsLocalValueBinding} for why a
 * destructured prop or a hook's returned setter was invisible to the chain. It
 * stays a separate predicate rather than a fifth case of the external one: those
 * calls are not external, they are simply unpinnable, and the two verdicts feed
 * different denominators.
 *
 * A DISPATCHING call needs the receiver twin of that guard, for the half the
 * external one declines to answer (bd tea-rags-mcp-z0zqd). Its checker arm
 * decides every receiver whose type resolves outside the project, but says
 * nothing about one with no resolvable type at all — an unannotated destructured
 * parameter, an `any`-returning hook — because it may only ever ADD an external
 * verdict. {@link receiverIsUnpinnableLocalValueBinding} decides those on the
 * DECLARATION instead, and only when the checker also names no in-project type,
 * so a destructured receiver holding a real project instance keeps its edge.
 *
 * The guard reads the resolver's `TSProgramCache` when one exists (bd
 * tea-rags-mcp-335eu), which is what lets it decline a receiver only the checker
 * could type — `const map = readRegistry(); map.set(k, v)`. The cache arrives as
 * its own constructor argument rather than through {@link ResolverConfig}, for
 * the same reason passes 11-14 take it that way: `ResolverConfig` is the
 * compiler-free config every strategy shares, and the cache is `null` whenever
 * `CODEGRAPH_TS_TYPECHECKER=0` removed the checker tier.
 */
export class TSGlobalShortNameSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "globalShortName";
  constructor(
    private readonly cfg: ResolverConfig,
    private readonly programCache: TSProgramCache | null = null,
  ) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (targetsExternalImport(call, ctx, this.cfg.tsOptions, this.programCache)) return CONTINUE;
    if (calleeIsLocalValueBinding(call, ctx, this.programCache)) return CONTINUE;
    if (receiverIsUnpinnableLocalValueBinding(call, ctx, this.programCache)) return CONTINUE;
    const fallback = ctx.symbolTable.lookupByShortName(call.member);
    const hit = pickSingleCandidate(fallback, this.cfg.mode);
    if (hit) return resolved({ targetRelPath: hit.relPath, targetSymbolId: hit.symbolId });
    return CONTINUE;
  }
}
