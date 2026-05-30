/**
 * Bash implementation of the `CallResolver` contract. Relocated from
 * `domains/trajectory/codegraph/symbols/resolvers/bash/bash-resolver.ts` into
 * the native Bash language provider per the `domains/language` consolidation
 * (spec §3; bd tea-rags-mcp-cen6). Behaviour-preserving.
 *
 * `resolve` runs an ordered chain of single-purpose `SymbolResolutionStrategy`
 * passes (see `./strategies/`) via the shared `resolveViaChain` engine. Bash
 * has a single pass — `globalShortName` — because Bash functions are global
 * within the sourced file set: `source ./other.sh` and `. ./other.sh` produce
 * ImportRefs with the literal path, and internal function calls (no receiver)
 * resolve via global short-name lookup over the symbol table, narrowed by the
 * caller's source list on ambiguity.
 */

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  type AmbiguousResolveMode,
  type CallContext,
  type CallRef,
  type CallResolver,
  type SymbolResolutionTarget,
} from "../../../../contracts/types/codegraph.js";
import type { SymbolResolutionStrategy } from "../../../../contracts/types/language.js";
import { resolveViaChain } from "../../resolver-chain.js";
import { BashGlobalShortNameSymbolResolutionStrategy, mapBashSourceToFile, type ResolverConfig } from "./strategies/index.js";

export { mapBashSourceToFile };

export class BashCallResolver implements CallResolver {
  readonly language = "bash";
  private readonly strategies: SymbolResolutionStrategy[];

  constructor(private readonly mode: AmbiguousResolveMode = DEFAULT_AMBIGUOUS_RESOLVE_MODE) {
    const cfg: ResolverConfig = { mode };
    this.strategies = [new BashGlobalShortNameSymbolResolutionStrategy(cfg)];
  }

  resolve(call: CallRef, ctx: CallContext): SymbolResolutionTarget | null {
    return resolveViaChain(this.strategies, call, ctx);
  }
}
