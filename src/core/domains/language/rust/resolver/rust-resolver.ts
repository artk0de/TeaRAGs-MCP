/**
 * Rust implementation of the `CallResolver` contract. Relocated from
 * `domains/trajectory/codegraph/symbols/resolvers/rust/rust-resolver.ts` into
 * the native Rust language provider per the `domains/language` consolidation
 * (spec §3; bd tea-rags-mcp-cen6). Behaviour-preserving.
 *
 * `resolve` runs an ordered chain of single-purpose `SymbolResolutionStrategy`
 * passes (see `./strategies/`) via the shared `resolveViaChain` engine. The
 * array order encodes precedence, and the three-state outcome
 * (resolved / drop / continue) makes the load-bearing guard drops explicit —
 * e.g. a `self.<field>` receiver whose field type is unknown DROPS rather than
 * falling through to the import-match / global short-name paths that would
 * route to an unrelated type's member (bd tea-rags-mcp-q1pl).
 *
 * Rust paths use `::` separators with prefixes:
 *   - `crate::` — current crate root
 *   - `super::` — parent module
 *   - `self::` — current module
 *   - bare paths — refer to a use'd import or external crate
 *
 * Without project-level Cargo metadata we resolve by basename match
 * over the symbol table — for `use crate::foo::bar`, look up `bar`
 * and accept any file whose path ends in `foo/bar.rs` (or
 * `foo/bar/mod.rs`). External crates are out of scope.
 *
 * The pass order (each `name` in parens):
 *   1. selfMethod (self.X same-file — intra-impl call)
 *   2. selfField (self.field.X via declared field type — terminal guard)
 *   3. localBinding (obj.X via walker-bound type — terminal guard on miss)
 *   4. importMatch (receiver ∈ use import → suffix basename match)
 *   5. bareSelfMethod (bare X() inside impl → enclosing-type probe)
 *   6. globalShortName (global short-name fallback)
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
  RustBareSelfMethodSymbolResolutionStrategy,
  RustGlobalShortNameSymbolResolutionStrategy,
  RustImportMatchSymbolResolutionStrategy,
  RustLocalBindingSymbolResolutionStrategy,
  RustSelfFieldSymbolResolutionStrategy,
  RustSelfMethodSymbolResolutionStrategy,
  type ResolverConfig,
} from "./strategies/index.js";

export class RustCallResolver implements CallResolver {
  readonly language = "rust";
  private readonly strategies: SymbolResolutionStrategy[];

  constructor(mode: AmbiguousResolveMode = DEFAULT_AMBIGUOUS_RESOLVE_MODE) {
    const cfg: ResolverConfig = { mode };
    this.strategies = [
      new RustSelfMethodSymbolResolutionStrategy(cfg),
      new RustSelfFieldSymbolResolutionStrategy(cfg),
      new RustLocalBindingSymbolResolutionStrategy(cfg),
      new RustImportMatchSymbolResolutionStrategy(cfg),
      new RustBareSelfMethodSymbolResolutionStrategy(cfg),
      new RustGlobalShortNameSymbolResolutionStrategy(cfg),
    ];
  }

  resolve(call: CallRef, ctx: CallContext): SymbolResolutionTarget | null {
    return resolveViaChain(this.strategies, call, ctx);
  }
}
