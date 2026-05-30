import {
  pickSingleCandidate,
  type CallContext,
  type CallRef,
} from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { CONTINUE, resolved } from "../../../../../contracts/resolution.js";
import { rustImportMatchesReceiver, rustImportSuffix, type ResolverConfig } from "./shared.js";

/**
 * `use crate::foo::bar` import-match — when the receiver matches a `use`
 * import's tail (or a member of a braced group `use foo::{a, b}`), reduce the
 * import to its module-path suffix and accept a short-name candidate whose file
 * ends in `<suffix>.rs` or `<suffix>/mod.rs`. Without project Cargo metadata
 * this basename match is how Rust `use` paths resolve to indexed files. On a
 * miss (no matching import, no suffix, or no candidate), continue to the
 * bare-self / global short-name passes — never a drop.
 */
export class RustImportMatchSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "importMatch";
  constructor(private readonly cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (!call.receiver) return CONTINUE;
    const { receiver } = call;
    const match = ctx.imports.find((imp) => rustImportMatchesReceiver(imp.importText, receiver));
    if (match) {
      const suffix = rustImportSuffix(match.importText);
      if (suffix) {
        const candidates = ctx.symbolTable
          .lookupByShortName(call.member)
          .filter((def) => def.relPath.endsWith(`${suffix}.rs`) || def.relPath.endsWith(`${suffix}/mod.rs`));
        const target = pickSingleCandidate(candidates, this.cfg.mode);
        if (target) return resolved({ targetRelPath: target.relPath, targetSymbolId: target.symbolId });
      }
    }
    return CONTINUE;
  }
}
