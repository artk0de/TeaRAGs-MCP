import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  type AmbiguousResolveMode,
  type CallContext,
  type CallRef,
  type CallResolver,
  type SymbolResolutionTarget,
} from "../../../../contracts/types/codegraph.js";
import type { SymbolResolutionStrategy } from "../../../../contracts/types/language.js";
import { resolveViaChain } from "../../kernel/index.js";
import { ObjcSelfInstanceMemberSymbolResolutionStrategy } from "./strategies/index.js";

/**
 * One pass: `[self selector]` inside an `@implementation` binds the instance
 * method in the caller file. A selector is shared by every class, so there is
 * no global short-name tail.
 */
export class ObjcCallResolver implements CallResolver {
  readonly language = "objc";
  private readonly strategies: SymbolResolutionStrategy[];

  constructor(_mode: AmbiguousResolveMode = DEFAULT_AMBIGUOUS_RESOLVE_MODE) {
    this.strategies = [new ObjcSelfInstanceMemberSymbolResolutionStrategy()];
  }

  resolve(call: CallRef, ctx: CallContext): SymbolResolutionTarget | null {
    return resolveViaChain(this.strategies, call, ctx);
  }
}
