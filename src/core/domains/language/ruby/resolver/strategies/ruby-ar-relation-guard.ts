import { CONTINUE, DROP } from "../../../../../contracts/resolution.js";
import type { CallContext, CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import type { ResolverConfig } from "./shared.js";

/**
 * AR Relation chain guard. When the receiver text contains an ActiveRecord
 * query-builder method (`where`/`order`/`joins`/etc.) the call is on an
 * AR::Relation, not on a user-defined class. Falling through to the global
 * short-name lookup would pick the wrong target — `Product.ransack(form)
 * .result(distinct: true)` historically mis-resolved to `AbstractPolicy#result`.
 * DROP the edge rather than guess.
 *
 * Continues when the receiver is null or doesn't look like an AR relation chain.
 */
export class RubyArRelationGuardSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "arRelationGuard";
  constructor(private readonly _cfg: ResolverConfig) {}

  attempt(call: CallRef, _ctx: CallContext): SymbolResolutionOutcome {
    if (call.receiver && receiverLooksLikeArRelationChain(call.receiver)) return DROP;
    return CONTINUE;
  }
}

/**
 * AR query-builder methods that return ActiveRecord::Relation. When the
 * receiver text of a call contains one of these as a `.method(` segment,
 * the receiver is a Relation rather than a user-defined class, and any
 * global short-name match would be a false positive. The list is the
 * conventional Rails AR API surface — narrow enough to avoid catching
 * unrelated methods named `where` / `order` on non-AR classes (those
 * trip when the receiver text is bare `obj.where`, but here we only
 * match the dot-prefixed chain form to keep the heuristic safe).
 */
const AR_RELATION_BUILDERS = [
  ".where(",
  ".order(",
  ".joins(",
  ".select(",
  ".group(",
  ".having(",
  ".includes(",
  ".eager_load(",
  ".preload(",
  ".limit(",
  ".offset(",
  ".distinct(",
  ".ransack(",
  ".unscope(",
  ".reorder(",
  ".except(",
  ".pluck(",
];

function receiverLooksLikeArRelationChain(receiver: string): boolean {
  for (const marker of AR_RELATION_BUILDERS) {
    if (receiver.includes(marker)) return true;
  }
  return false;
}
