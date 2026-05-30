/**
 * Ruby implementation of the `CallResolver` contract.
 *
 * `resolve` runs an ordered chain of single-purpose `SymbolResolutionStrategy`
 * passes (see `./strategies/`) via the shared `resolveViaChain` engine. The
 * array order encodes precedence, and the three-state outcome
 * (resolved / drop / continue) makes the load-bearing guard drops explicit —
 * e.g. `super`/`zsuper` without a resolvable ancestor DROPS rather than falling
 * through to the bare-call fallback that would fabricate a wrong edge
 * (bd tea-rags-mcp-jsa0 / lttd; same family as the TS bug 4rgg).
 *
 * Two channels per the ruby-walker output flow through the chain:
 *
 *   1. Explicit `require`/`require_relative` — importText carries the string
 *      literal (with a "./" prefix for relative); resolved by the
 *      `explicitRequire` pass via basename / filesystem-relative match.
 *   2. Zeitwerk constant references — importText starts with the `zeitwerk:`
 *      prefix; resolved by the `constant` pass over the symbol table's known
 *      file paths (the `resolveConstant` helper shared with local-type / super).
 *
 * The pass order (each `name` in parens):
 *   1. super (super/zsuper via classAncestors — terminal guard)
 *   2. localType (receiver.X via walker-bound local type — terminal guard)
 *   3. constant (Zeitwerk-style Constant.X via resolveConstant)
 *   4. explicitRequire (receiver names a require / require_relative import)
 *   5. arRelationGuard (AR::Relation chain receiver — terminal guard)
 *   6. receiverSetDrop (any remaining receiver-set call — terminal guard)
 *   7. bareCall (bare-call global short-name fallback — last pass)
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
import {
  RubyArRelationGuardSymbolResolutionStrategy,
  RubyBareCallSymbolResolutionStrategy,
  RubyConstantSymbolResolutionStrategy,
  RubyExplicitRequireSymbolResolutionStrategy,
  RubyLocalTypeSymbolResolutionStrategy,
  RubyReceiverSetDropSymbolResolutionStrategy,
  RubySuperSymbolResolutionStrategy,
  type ResolverConfig,
} from "./strategies/index.js";

export class RubyCallResolver implements CallResolver {
  readonly language = "ruby";
  private readonly strategies: SymbolResolutionStrategy[];

  constructor(private readonly mode: AmbiguousResolveMode = DEFAULT_AMBIGUOUS_RESOLVE_MODE) {
    const cfg: ResolverConfig = { mode };
    this.strategies = [
      new RubySuperSymbolResolutionStrategy(cfg),
      new RubyLocalTypeSymbolResolutionStrategy(cfg),
      new RubyConstantSymbolResolutionStrategy(cfg),
      new RubyExplicitRequireSymbolResolutionStrategy(cfg),
      new RubyArRelationGuardSymbolResolutionStrategy(cfg),
      new RubyReceiverSetDropSymbolResolutionStrategy(cfg),
      new RubyBareCallSymbolResolutionStrategy(cfg),
    ];
  }

  resolve(call: CallRef, ctx: CallContext): SymbolResolutionTarget | null {
    return resolveViaChain(this.strategies, call, ctx);
  }
}
