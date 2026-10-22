import { identifierEntry } from "../../../../../contracts/identifier-record.js";
import { CONTINUE, DROP, resolved } from "../../../../../contracts/resolution.js";
import {
  pickSingleCandidate,
  type CallContext,
  type CallRef,
  type SymbolResolutionTarget,
} from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { capability } from "../../capability.js";
import {
  parseRustImportPath,
  rustCalleeShortNameCandidates,
  rustDeclaresTypeAlias,
  rustImportBindings,
  rustImportCandidatePaths,
  rustImportContainsReceiver,
  rustImportIsExternal,
  rustModuleFileKnown,
  rustPathCandidatePaths,
  rustReexportSourcePaths,
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
      const follow = this.followReexports(call, matchingImport.importText, call.member, ctx);
      if (follow.target) return resolved(follow.target);
      return follow.open ? CONTINUE : DROP;
    }
    const { receiver } = call;
    const matchingImport = ctx.imports.find((imp) => parseRustImportPath(imp.importText, receiver)?.receiverMatches);
    if (matchingImport) {
      const candidatePaths = rustImportCandidatePaths(matchingImport.importText, receiver, ctx.callerFile, ctx);
      if (candidatePaths === null) return CONTINUE;
      const candidates = ctx.symbolTable
        .lookupByShortName(call.member, { kinds: capability.codegraph.symbolKindRoles.callee })
        .filter((def) => candidatePaths.includes(def.relPath) && def.relPath.endsWith(".rs"));
      const reexport = this.followReexports(call, matchingImport.importText, receiver, ctx).target;
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

  /**
   * Follow the `pub use` re-exports of the module an import pins, hop-bounded
   * by {@link RUST_REEXPORT_HOP_CAP}. `target` is the one definition the walk
   * ends at; `open` is set when the walk met something it cannot follow — an
   * unknown or absent module file, a relative path it cannot place, a glob
   * from an external crate, the hop cap, the reexport channel absent, or more
   * than one definition — so its silence is no proof of absence.
   */
  private followReexports(call: CallRef, importText: string, receiver: string, ctx: CallContext): RustReexportFollow {
    const parsed = parseRustImportPath(importText, receiver);
    if (!parsed || ctx.moduleReexports === undefined) return { target: null, open: true };
    const ownerSegments = parsed.sourceName === null ? parsed.moduleSegments.slice(0, -1) : parsed.moduleSegments;
    const exportedName = parsed.sourceName === null ? (parsed.moduleSegments.at(-1) ?? receiver) : parsed.sourceName;
    const ownerFiles = rustPathCandidatePaths(parsed, ownerSegments, ctx.callerFile, ctx).filter((relPath) =>
      rustModuleFileKnown(relPath, ctx),
    );
    // An inline `mod tests { pub use … }` has no file of its own: nothing proves absence.
    let open = ownerFiles.length === 0;
    const targets: SymbolResolutionTarget[] = [];
    const visited = new Set<string>();
    const visit = (moduleFile: string, name: string, depth: number): void => {
      const key = `${moduleFile}::${name}`;
      if (visited.has(key)) return;
      visited.add(key);
      for (const entry of identifierEntry(ctx.moduleReexports, moduleFile) ?? []) {
        if (entry.exportedName !== name && entry.exportedName !== "*") continue;
        if (depth >= RUST_REEXPORT_HOP_CAP) {
          open = true;
          continue;
        }
        const sourcePaths = rustReexportSourcePaths(entry.sourceModule, moduleFile, ctx);
        // A NAMED re-export of an external item proves the name external; a
        // glob from an external crate may or may not carry it.
        if (sourcePaths === "external") {
          if (entry.exportedName === "*") open = true;
          continue;
        }
        if (sourcePaths === null) {
          open = true;
          continue;
        }
        const sourceName = entry.exportedName === "*" ? name : (entry.sourceName ?? name);
        const moduleItemPaths =
          entry.sourceName === undefined
            ? []
            : rustReexportSourcePaths(`${entry.sourceModule}::${entry.sourceName}`, moduleFile, ctx);
        const sourceFiles = [
          ...new Set([...sourcePaths, ...(Array.isArray(moduleItemPaths) ? moduleItemPaths : [])]),
        ].filter((relPath) => rustModuleFileKnown(relPath, ctx));
        if (sourceFiles.length === 0) {
          open = true;
          continue;
        }
        const targetName = call.receiver ? call.member : sourceName;
        const defs = rustCalleeShortNameCandidates(ctx, targetName);
        for (const sourceFile of sourceFiles) {
          for (const def of defs) {
            if (def.relPath === sourceFile) {
              targets.push({ targetRelPath: def.relPath, targetSymbolId: def.symbolId });
            }
          }
          visit(sourceFile, sourceName, depth + 1);
        }
      }
    };
    for (const ownerFile of ownerFiles) visit(ownerFile, exportedName, 0);
    const unique = [...new Map(targets.map((target) => [target.targetRelPath, target])).values()];
    if (unique.length === 1) return { target: unique[0], open };
    return { target: null, open: open || unique.length > 1 };
  }
}

/** How many `pub use` hops importMatch follows from the pinned module before it stops proving absence. */
const RUST_REEXPORT_HOP_CAP = 4;

interface RustReexportFollow {
  target: SymbolResolutionTarget | null;
  open: boolean;
}
