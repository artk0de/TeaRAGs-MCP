import { CONTINUE, DROP } from "../../../../../contracts/resolution.js";
import type { CallContext, CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import type { ResolverConfig } from "./shared.js";

/**
 * `$this` is `thisMember`. A variable whose type the walker recorded is
 * `typedReceiver`. `Bar::make()` in this file or behind a `use` is
 * `scopedCall`. Everything else with a receiver — `$repo->save()` with no
 * type, `parent::m()` — drops here.
 */
export class PhpQualifiedReceiverSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "qualifiedReceiver";
  constructor(_cfg: ResolverConfig) {}

  attempt(call: CallRef, _ctx: CallContext): SymbolResolutionOutcome {
    return call.receiver !== null ? DROP : CONTINUE;
  }
}
