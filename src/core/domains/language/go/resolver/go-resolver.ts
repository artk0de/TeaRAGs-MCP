/**
 * Go implementation of the `CallResolver` contract. Relocated from
 * `domains/trajectory/codegraph/symbols/resolvers/go/go-resolver.ts` into the
 * native Go language provider per the `domains/language` consolidation (spec
 * §3; bd tea-rags-mcp-cen6). Behaviour-preserving.
 *
 * `resolve` runs an ordered chain of single-purpose `SymbolResolutionStrategy`
 * passes (see `./strategies/`) via the shared `resolveViaChain` engine. The
 * array order encodes precedence, and the four-state outcome
 * (resolved / deferred / drop / continue) makes the load-bearing guard drops explicit —
 * e.g. a known local type whose member is absent DROPS rather than falling
 * through to global short-name, which fabricates false positives.
 *
 * The pass order (each `name` in parens), mirroring PythonCallResolver step 0:
 *   1. localBinding      (Step 0 — `localBindings[receiver]` typed receiver;
 *                          guard: resolves or drops, bd tea-rags-mcp-e6xx)
 *   2. returnTypeBinding (Step 0b — call bindings (`callResultBindings`) +
 *                          `functionReturnTypes` with the concrete-type gate,
 *                          bd tea-rags-mcp-6g9c)
 *   3. receiverChain     (Step 0c — dotted or call-result receiver typed
 *                          through struct fields / the callee's return type;
 *                          guard: resolves or drops, bd tea-rags-mcp-e6xx)
 *   4. importMatch       (Step 1 — receiver is the name an import binds, and
 *                          no local in scope shadows it)
 *   5. receiverDrop      (Step 2 — receiver matched nothing; terminal drop,
 *                          bd tea-rags-mcp-m46z)
 *   6. genericInstantiation (Step 2b — bare `f[T](…)`: the same-package
 *                          declaration `f`, bd tea-rags-mcp-e6xx)
 *   7. globalShortName   (Step 3 — no receiver: a package-level declaration
 *                          of the caller's package or a dot-import)
 *
 * The three typed passes share `resolveByLocalType`, so method promotion
 * through struct embedding (`engine.GET` → `RouterGroup#GET`) applies to each.
 * `receiverChain` sits before `importMatch` only for reading order: it answers
 * dotted and call-result receivers alone, and neither ever equals an import's
 * name, so the two passes never compete for a call. Every pass reads a
 * receiver's local through `goLocalAt` (Go's statement and block scope) and
 * the symbol table through `go-symbol-lookup.ts` (Go declarations only).
 *
 * Go imports are package paths. With go.mod files in the project an import
 * maps to a project package through the module map (`go-module-map.ts`,
 * re-read at every pass start): `<module>/<subpath>` is `<subpath>` beneath
 * that go.mod, nested modules by longest prefix, and an import under no
 * project module — the standard library, a dependency — is no project
 * package. Without any go.mod (GOPATH-shaped trees) the import path is the
 * package's directory. Either way the match is the package's exact directory.
 * Codegraph excludes `vendor/`, and the module map never reads a go.mod under
 * it.
 */

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  type AmbiguousResolveMode,
  type CallContext,
  type CallRef,
  type CallResolver,
  type SymbolResolutionPassPlan,
  type SymbolResolutionTarget,
} from "../../../../contracts/types/codegraph.js";
import type { SymbolIdComposer, SymbolResolutionStrategy } from "../../../../contracts/types/language.js";
import { resolveViaChain } from "../../resolver-chain.js";
import { GoModuleMapCache } from "./go-module-map.js";
import {
  GoGenericInstantiationSymbolResolutionStrategy,
  GoGlobalShortNameSymbolResolutionStrategy,
  GoImportMatchSymbolResolutionStrategy,
  GoLocalBindingSymbolResolutionStrategy,
  GoReceiverChainSymbolResolutionStrategy,
  GoReceiverDropSymbolResolutionStrategy,
  GoReturnTypeBindingSymbolResolutionStrategy,
  type ResolverConfig,
} from "./strategies/index.js";

export class GoCallResolver implements CallResolver {
  readonly language = "go";
  private readonly strategies: SymbolResolutionStrategy[];
  /** The project's go.mod module map, read once per root and re-read at every pass start. */
  private readonly moduleMaps = new GoModuleMapCache();

  /**
   * `composer` builds the `Type#member` / `Type.member` candidate ids per the
   * project-wide symbolId convention (`.claude/rules/symbolid-convention.md`).
   * Injected as the contracts `SymbolIdComposer` interface. `GoLanguage`
   * self-constructs the concrete `DefaultSymbolIdComposer` (a stateless pure
   * mapper in the same `domains/language` domain) and passes it here.
   */
  constructor(composer: SymbolIdComposer, mode: AmbiguousResolveMode = DEFAULT_AMBIGUOUS_RESOLVE_MODE) {
    const cfg: ResolverConfig = { composer, mode, moduleMaps: this.moduleMaps };
    this.strategies = [
      new GoLocalBindingSymbolResolutionStrategy(cfg),
      new GoReturnTypeBindingSymbolResolutionStrategy(cfg),
      new GoReceiverChainSymbolResolutionStrategy(cfg),
      new GoImportMatchSymbolResolutionStrategy(cfg),
      new GoReceiverDropSymbolResolutionStrategy(cfg),
      new GoGenericInstantiationSymbolResolutionStrategy(cfg),
      new GoGlobalShortNameSymbolResolutionStrategy(cfg),
    ];
  }

  resolve(call: CallRef, ctx: CallContext): SymbolResolutionTarget | null {
    return resolveViaChain(this.strategies, call, ctx);
  }

  /**
   * Re-read the project's go.mod files before pass-2's first call (bd
   * tea-rags-mcp-e6xx), so a long-lived process never resolves a run against
   * the module paths of an earlier one. A resolve with a root this pass never
   * announced still reads it lazily.
   */
  prepareResolvePass(plan: SymbolResolutionPassPlan): void {
    this.moduleMaps.reload(plan.projectRoot);
  }
}
