/**
 * Go implementation of the `CallResolver` contract. Relocated from
 * `domains/trajectory/codegraph/symbols/resolvers/go/go-resolver.ts` into the
 * native Go language provider per the `domains/language` consolidation (spec
 * §3; bd tea-rags-mcp-cen6). Behaviour-preserving.
 *
 * `resolve` runs an ordered chain of single-purpose `SymbolResolutionStrategy`
 * passes (see `./strategies/`) via the shared `resolveViaChain` engine. The
 * array order encodes precedence, and the three-state outcome
 * (resolved / drop / continue) makes the load-bearing guard drops explicit —
 * e.g. a known local type whose member is absent DROPS rather than falling
 * through to global short-name, which fabricates false positives.
 *
 * The pass order (each `name` in parens), mirroring PythonCallResolver step 0:
 *   1. localBinding      (Step 0 — `localBindings[receiver]` typed receiver;
 *                          guard: resolves or drops, bd tea-rags-mcp-e6xx)
 *   2. returnTypeBinding (Step 0b — `localCallBindings` + `functionReturnTypes`
 *                          with the concrete-type gate, bd tea-rags-mcp-6g9c)
 *   3. importMatch       (Step 1 — receiver matches an import's last segment)
 *   4. receiverDrop      (Step 2 — receiver matched nothing; terminal drop,
 *                          bd tea-rags-mcp-m46z)
 *   5. globalShortName   (Step 3 — no receiver: global short-name fallback)
 *
 * Go imports are package paths ("foo/bar"). Without GOPATH / module config we
 * can only resolve project-local packages via basename heuristic. Cross-module
 * imports (third-party) are out of scope; codegraph excludes `vendor/` and the
 * dependency directories the walker doesn't see.
 */

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  type AmbiguousResolveMode,
  type CallContext,
  type CallRef,
  type CallResolver,
  type SymbolResolutionTarget,
} from "../../../../contracts/types/codegraph.js";
import type { SymbolIdComposer, SymbolResolutionStrategy } from "../../../../contracts/types/language.js";
import { resolveViaChain } from "../../resolver-chain.js";
import {
  GoGlobalShortNameSymbolResolutionStrategy,
  GoImportMatchSymbolResolutionStrategy,
  GoLocalBindingSymbolResolutionStrategy,
  GoReceiverDropSymbolResolutionStrategy,
  GoReturnTypeBindingSymbolResolutionStrategy,
  type ResolverConfig,
} from "./strategies/index.js";

export class GoCallResolver implements CallResolver {
  readonly language = "go";
  private readonly strategies: SymbolResolutionStrategy[];

  /**
   * `composer` builds the `Type#member` / `Type.member` candidate ids per the
   * project-wide symbolId convention (`.claude/rules/symbolid-convention.md`).
   * Injected as the contracts `SymbolIdComposer` interface. `GoLanguage`
   * self-constructs the concrete `DefaultSymbolIdComposer` (a stateless pure
   * mapper in the same `domains/language` domain) and passes it here.
   */
  constructor(
    composer: SymbolIdComposer,
    mode: AmbiguousResolveMode = DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  ) {
    const cfg: ResolverConfig = { composer, mode };
    this.strategies = [
      new GoLocalBindingSymbolResolutionStrategy(cfg),
      new GoReturnTypeBindingSymbolResolutionStrategy(cfg),
      new GoImportMatchSymbolResolutionStrategy(cfg),
      new GoReceiverDropSymbolResolutionStrategy(cfg),
      new GoGlobalShortNameSymbolResolutionStrategy(cfg),
    ];
  }

  resolve(call: CallRef, ctx: CallContext): SymbolResolutionTarget | null {
    return resolveViaChain(this.strategies, call, ctx);
  }
}
