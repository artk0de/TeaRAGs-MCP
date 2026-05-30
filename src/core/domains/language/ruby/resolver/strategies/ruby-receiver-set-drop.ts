import type { CallContext, CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { CONTINUE, DROP } from "../../../../../contracts/resolution.js";
import type { ResolverConfig } from "./shared.js";

/**
 * Receiver-set drop guard (bd tea-rags-mcp-lttd). When a receiver is set but
 * every prior channel (local binding, Zeitwerk constant lookup, explicit
 * require) failed, the dynamic type is unknown. Falling through to the global
 * short-name lookup fabricates false positives — `serializer.is_valid` →
 * unrelated `SomeForm#is_valid`, `Regexp.escape(domain)` →
 * `Rack::Protection::EscapedParams#escape`, `agents.map(&:id)` → JS `d3.js#map`.
 * Mirrors the Go / Java resolver pattern (drop instead of guess).
 *
 * MUST run AFTER the local-type, constant, explicit-require and AR-relation
 * passes — it is the catch-all for any remaining receiver-set call. The
 * bare-call fallback below it still applies because there's no receiver context
 * to narrow with, so this guard only fires when `call.receiver !== null`.
 */
export class RubyReceiverSetDropSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "receiverSetDrop";
  constructor(private readonly _cfg: ResolverConfig) {}

  attempt(call: CallRef, _ctx: CallContext): SymbolResolutionOutcome {
    if (call.receiver !== null) return DROP;
    return CONTINUE;
  }
}
