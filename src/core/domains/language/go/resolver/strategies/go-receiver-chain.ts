import { CONTINUE, DROP, resolved } from "../../../../../contracts/resolution.js";
import type { CallContext, CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { propagateReceiverType, type ReceiverTypePorts } from "../../../kernel/receiver-type-propagation.js";
import { createGoReceiverTypePorts, goBareCallHead } from "../receiver-type-ports.js";
import { resolveByLocalType, type ResolverConfig } from "./shared.js";

/**
 * Step 0c (bd tea-rags-mcp-e6xx) — a DOTTED receiver typed through struct
 * fields: `c.writermem.reset(w)` → `responseWriter#reset`, `c.engine.trees.get(m)`
 * → `methodTrees#get`. The kernel fold types the head the way the two binding
 * passes do and every further hop as a field (`receiver-type-ports.ts`).
 *
 * A guard once the receiver is typed, exactly like `localBinding`: the call
 * resolves on that type (promotion included) or DROPS — never a short-name
 * fallback, which would pick `responseWriter#Header` for an interface-typed
 * `c.Writer.Header()`. An untyped receiver CONTINUEs, and a dotted receiver has
 * nowhere left to go but the terminal drop, so the chain's outcome for every
 * receiver this pass cannot type is what it was before the pass existed.
 *
 * A receiver that is one bare call's result (`engine().GET(...)`, gin's
 * `ginS` wrappers) is a head the fold types too — through the callee's
 * declared return type (bd tea-rags-mcp-e6xx) — and is owned the same way; it
 * matches no import either, so an untyped one still ends at the terminal drop.
 *
 * A single-identifier receiver is the binding passes' own case and CONTINUEs
 * untouched.
 */
export class GoReceiverChainSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "receiverChain";
  private readonly ports: ReceiverTypePorts;

  constructor(private readonly cfg: ResolverConfig) {
    this.ports = createGoReceiverTypePorts(cfg.composer);
  }

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    const { receiver } = call;
    if (!receiver || (!receiver.includes(".") && goBareCallHead(receiver) === undefined)) return CONTINUE;
    const type = propagateReceiverType(receiver, call.startLine, ctx, this.ports);
    if (type?.form !== "instance") return CONTINUE;
    const target = resolveByLocalType(this.cfg, type.name, call.member, ctx);
    return target ? resolved(target) : DROP;
  }
}
