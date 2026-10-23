import { CONTINUE, DROP, resolved } from "../../../../../contracts/resolution.js";
import { pickSingleCandidate, type CallContext, type CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { capability } from "../../capability.js";
import { rustDeclaresFreeFn, rustPlaceItemPath } from "../declaring-file-type.js";
import {
  parseRustImportPath,
  rustCalleeShortNameCandidates,
  rustDeclaresTypeAlias,
  rustFollowReexports,
  rustImportBindings,
  rustImportCandidatePaths,
  rustImportContainsReceiver,
  rustImportIsExternal,
  type ResolverConfig,
} from "./shared.js";

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
    if (!call.receiver) {
      const matchingImport = ctx.imports.find((imp) =>
        rustImportBindings(imp.importText)?.some((binding) => binding.localName === call.member && !binding.globImport),
      );
      if (!matchingImport) return CONTINUE;
      // A DIRECT binding names the file the callee lives in — the same
      // candidate paths the receiver arm filters by. Only a `pub use`
      // indirection needs the reexport walk; asking it first made every
      // direct `use crate::mod::fn` + bare call a DROP whenever the run's
      // reexport channel was absent (bd tea-rags-mcp-2g2og).
      const candidatePaths = rustImportCandidatePaths(matchingImport.importText, call.member, ctx.callerFile, ctx);
      if (candidatePaths !== null) {
        const candidates = rustCalleeShortNameCandidates(ctx, call.member).filter((def) =>
          candidatePaths.includes(def.relPath),
        );
        const direct = pickSingleCandidate(candidates, this.cfg.mode);
        if (direct) return resolved({ targetRelPath: direct.relPath, targetSymbolId: direct.symbolId });
      }
      // A std / external-crate binding names no project definition.
      if (rustImportIsExternal(matchingImport.importText, ctx, call.member)) return DROP;
      // The pinned module re-exports the name (tikv `store/mod.rs`:
      // `pub use self::{peer::{find_peer}}`). DROP only on proof that the
      // module neither declares nor re-exports it; anything the walk cannot
      // follow leaves the call to the later passes (bd tea-rags-mcp-s3i8m.8).
      const follow = rustFollowReexports(matchingImport.importText, call.member, ctx.callerFile, ctx, (sourceName) =>
        rustCalleeShortNameCandidates(ctx, sourceName),
      );
      if (follow.target) return resolved(follow.target);
      return follow.open ? CONTINUE : DROP;
    }
    const { receiver } = call;
    // A module path `tikv_util::mpsc::unbounded(..)` names its free fn
    // outright: placed through the module system, else read as before.
    if (receiver.includes("::")) {
      const placed = rustPlaceItemPath(`${receiver}::${call.member}`, ctx.callerFile, ctx, rustDeclaresFreeFn);
      if (placed !== undefined) return resolved(placed);
    }
    const matchingImport = ctx.imports.find((imp) => parseRustImportPath(imp.importText, receiver)?.receiverMatches);
    if (matchingImport) {
      const candidatePaths = rustImportCandidatePaths(matchingImport.importText, receiver, ctx.callerFile, ctx);
      if (candidatePaths === null) return CONTINUE;
      const candidates = ctx.symbolTable
        .lookupByShortName(call.member, { kinds: capability.codegraph.symbolKindRoles.callee })
        .filter((def) => candidatePaths.includes(def.relPath) && def.relPath.endsWith(".rs"));
      const reexport = rustFollowReexports(matchingImport.importText, receiver, ctx.callerFile, ctx, () =>
        rustCalleeShortNameCandidates(ctx, call.member),
      ).target;
      if (reexport) return resolved(reexport);
      const target = pickSingleCandidate(candidates, this.cfg.mode);
      if (target) return resolved({ targetRelPath: target.relPath, targetSymbolId: target.symbolId });
      // A workspace crate the project holds (`use grep::cli;`, crate dir present)
      // is proven internal, but its crate name maps to no module file here: the
      // path miss is ours, not the call's, so the later passes still answer it.
      const binding = parseRustImportPath(matchingImport.importText, receiver);
      if (binding?.prefix === null && !rustImportIsExternal(matchingImport.importText, ctx, receiver)) return CONTINUE;
      // An imported type ALIAS (`type Range = Match;`) carries its target's
      // members, not its own file's: the binding proves no member location,
      // so the later passes answer it (bd tea-rags-mcp-sjego — ripgrep's
      // searcher core.rs `Range::zero`).
      return rustDeclaresTypeAlias(receiver, candidatePaths, ctx) ? CONTINUE : DROP;
    }
    if (
      ctx.imports.some(
        (imp) =>
          parseRustImportPath(imp.importText, receiver) === null &&
          rustImportContainsReceiver(imp.importText, receiver),
      )
    ) {
      return DROP;
    }
    return CONTINUE;
  }
}
