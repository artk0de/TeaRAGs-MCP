/**
 * Java implementation of the `CallResolver` contract. Relocated from
 * `domains/trajectory/codegraph/symbols/resolvers/java/java-resolver.ts` into
 * the native Java language provider per the `domains/language` consolidation
 * (spec §3; bd tea-rags-mcp-cen6). Behaviour-preserving.
 *
 * Java imports name fully-qualified types: `com.foo.Bar` →
 * `com/foo/Bar.java`. Wildcard imports (`com.foo.*`) point at a
 * package (directory) rather than a single file, so resolution
 * relies on the symbol table's short-name lookup restricted to that
 * directory.
 *
 * `resolve` runs an ordered chain of single-purpose `SymbolResolutionStrategy`
 * passes (see `./strategies/`) via the shared `resolveViaChain` engine. The
 * array order encodes precedence, and the three-state outcome
 * (resolved / drop / continue) makes the load-bearing guard drop explicit — a
 * receiver-present call that matches no import / binding / java.lang type DROPS
 * rather than falling through to the bare-call short-name lookup that would
 * fabricate a same-class false-positive edge (mirrors the TS `super` guard, bd
 * tea-rags-mcp-4rgg family).
 *
 * The pass order (each `name` in parens):
 *   1. thisMember        (this.X same-file enclosing member)
 *   2. fieldType         (this.field.X via declared field type)
 *   3. localBinding      (param.X / localVar.X via walker-bound type)
 *   4. importReceiver    (receiver via import / wildcard scope / java.lang — terminal guard)
 *   5. enclosingBareCall (bare foo() → enclosing-class member, same file)
 *   6. globalShortName   (terminal global short-name fallback)
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
  JavaEnclosingBareCallSymbolResolutionStrategy,
  JavaFieldTypeSymbolResolutionStrategy,
  JavaGlobalShortNameSymbolResolutionStrategy,
  JavaImportReceiverSymbolResolutionStrategy,
  JavaLocalBindingSymbolResolutionStrategy,
  JavaThisMemberSymbolResolutionStrategy,
  mapJavaImportToFile,
  type ResolverConfig,
} from "./strategies/index.js";

export { mapJavaImportToFile };

export class JavaCallResolver implements CallResolver {
  readonly language = "java";
  private readonly strategies: SymbolResolutionStrategy[];

  constructor(mode: AmbiguousResolveMode = DEFAULT_AMBIGUOUS_RESOLVE_MODE) {
    const cfg: ResolverConfig = { mode };
    this.strategies = [
      new JavaThisMemberSymbolResolutionStrategy(cfg),
      new JavaFieldTypeSymbolResolutionStrategy(cfg),
      new JavaLocalBindingSymbolResolutionStrategy(cfg),
      new JavaImportReceiverSymbolResolutionStrategy(cfg),
      new JavaEnclosingBareCallSymbolResolutionStrategy(cfg),
      new JavaGlobalShortNameSymbolResolutionStrategy(cfg),
    ];
  }

  resolve(call: CallRef, ctx: CallContext): SymbolResolutionTarget | null {
    return resolveViaChain(this.strategies, call, ctx);
  }
}
