import { CONTINUE, resolved } from "../../../../../contracts/resolution.js";
import { pickSingleCandidate, type CallContext, type CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { lookupSwiftSymbolsByShortName } from "../swift-symbol-lookup.js";
import type { SwiftResolverConfig } from "./shared.js";

/**
 * Terminal short-name fallback for BARE calls the enclosing-type passes did not
 * claim: a free function, or a type named by a construction expression
 * (`Repository()` is recorded as a bare call whose member is `Repository`, and
 * the type's own symbol is what it lands on).
 *
 * **It answers bare calls only, and that is the precision decision of this
 * chain.** Every other language reaches its short-name tail having first
 * narrowed a receiver through imports: Java's `importReceiver` drops what the
 * fully-qualified import table cannot place, TypeScript demands checker or
 * structural evidence before committing a member call. Swift has neither to
 * offer — `import Foundation` names a MODULE, never a symbol, so no import
 * ever narrows a receiver — which leaves a receiver-bearing call here with
 * exactly the evidence JavaScript's tail was measured on and found to have
 * none: every receiver-bearing edge it produced was fabricated
 * (bd tea-rags-mcp-hwwtw). So an unknown receiver emits NOTHING rather than the
 * project's lone namesake.
 *
 * That is also why the Swift chain builds no import-match strategy at all. One
 * could be written — match a receiver against an imported module name — but it
 * would only ever fire on `SomeModule.function()`, where the receiver is a
 * module rather than a value, and Swift's module-scoped functions are rare
 * enough that the pass would be almost pure fabrication risk.
 *
 * `pickSingleCandidate(mode)` returns the sole hit (strict) or the first
 * (legacy `first`). Non-decisive → continue; the chain then exhausts and emits
 * no edge.
 */
export class SwiftGlobalShortNameSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "globalShortName";
  constructor(private readonly cfg: SwiftResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (call.receiver !== null) return CONTINUE;
    const hit = pickSingleCandidate(lookupSwiftSymbolsByShortName(ctx, call.member), this.cfg.mode);
    if (hit) return resolved({ targetRelPath: hit.relPath, targetSymbolId: hit.symbolId });
    return CONTINUE;
  }
}
