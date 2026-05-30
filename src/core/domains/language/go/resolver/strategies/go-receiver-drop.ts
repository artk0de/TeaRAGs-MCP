import type { CallContext, CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { CONTINUE, DROP } from "../../../../../contracts/resolution.js";
import type { ResolverConfig } from "./shared.js";

/**
 * Step 2 — terminal guard for a receiver-present call that matched NEITHER a
 * localBinding NOR a returnType binding NOR an import. Chained / method
 * receivers (e.g. `c.Request.URL.Query()`) and bare receivers that don't match
 * any import — we don't know the dynamic type. Go method dispatch on chained
 * receivers is intentionally out of scope: guessing fabricates cycles.
 *
 * Dropping the edge is safer than a global short-name fallback, which would
 * fabricate false-positive cycles (e.g. matching `c.Request.URL.Query()`
 * against the unique `Context#Query` symbol just because "Query" is unique).
 * The no-receiver global fallback never reaches this strategy — it CONTINUEs to
 * the next pass.
 */
export class GoReceiverDropSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "receiverDrop";
  constructor(private readonly _cfg: ResolverConfig) {}

  attempt(call: CallRef, _ctx: CallContext): SymbolResolutionOutcome {
    if (!call.receiver) return CONTINUE;
    return DROP;
  }
}
