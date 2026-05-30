/**
 * Python implementation of the `CallResolver` contract. Relocated from
 * `domains/trajectory/codegraph/symbols/resolvers/python/python-resolver.ts`
 * into the native Python language provider per the `domains/language`
 * consolidation (spec §3; bd tea-rags-mcp-cen6). Behaviour-preserving.
 *
 * `resolve` runs an ordered chain of single-purpose `SymbolResolutionStrategy`
 * passes (see `./strategies/`) via the shared `resolveViaChain` engine. The
 * array order encodes precedence, and the three-state outcome
 * (resolved / drop / continue) makes the load-bearing guard drops explicit —
 * a `self.<field>` / `self` / `super()` / locally-bound receiver that fails to
 * resolve DROPS rather than falling through to the ambiguous global short-name
 * path (which is exactly the source of the ugnest false positive,
 * `serializer.is_valid()` attributed to `ConfirmationCode`).
 *
 * The pass order (each `name` in parens):
 *   1. super (super().X via classExtends — terminal guard)
 *   2. selfField (self.<field>.X via classFieldTypes — terminal guard)
 *   3. selfMember (self.X via enclosing class + classExtends walk — terminal guard)
 *   4. localBinding (var.X via walker-bound type — terminal guard)
 *   5. importMatch (receiver matches an import's trailing segment)
 *   6. globalShortName (global short-name fallback)
 *
 * Python's syntax differs from TS in import style (`from foo import bar`), so
 * the "receiver matches an import" check also considers names imported via
 * `from X import Y` — Y becomes a locally-bound name even though X is the module
 * file. This is pragmatically handled by accepting the final segment of the
 * import path as the receiver match.
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
  PythonGlobalShortNameSymbolResolutionStrategy,
  PythonImportMatchSymbolResolutionStrategy,
  PythonLocalBindingSymbolResolutionStrategy,
  PythonSelfFieldSymbolResolutionStrategy,
  PythonSelfMemberSymbolResolutionStrategy,
  PythonSuperSymbolResolutionStrategy,
  type ResolverConfig,
} from "./strategies/index.js";

export class PythonCallResolver implements CallResolver {
  readonly language = "python";
  private readonly strategies: SymbolResolutionStrategy[];

  constructor(mode: AmbiguousResolveMode = DEFAULT_AMBIGUOUS_RESOLVE_MODE) {
    const cfg: ResolverConfig = { mode };
    this.strategies = [
      new PythonSuperSymbolResolutionStrategy(cfg),
      new PythonSelfFieldSymbolResolutionStrategy(cfg),
      new PythonSelfMemberSymbolResolutionStrategy(cfg),
      new PythonLocalBindingSymbolResolutionStrategy(cfg),
      new PythonImportMatchSymbolResolutionStrategy(cfg),
      new PythonGlobalShortNameSymbolResolutionStrategy(cfg),
    ];
  }

  resolve(call: CallRef, ctx: CallContext): SymbolResolutionTarget | null {
    return resolveViaChain(this.strategies, call, ctx);
  }
}
