import { CONTINUE, DROP, resolved } from "../../../../../contracts/resolution.js";
import { pickSingleCandidate, type CallContext, type CallRef } from "../../../../../contracts/types/codegraph.js";
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
  rustPathCandidatePaths,
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
      const reexport = this.resolveReexport(call, matchingImport.importText, call.member, ctx);
      return reexport ? resolved(reexport) : DROP;
    }
    const { receiver } = call;
    const matchingImport = ctx.imports.find((imp) => parseRustImportPath(imp.importText, receiver)?.receiverMatches);
    if (matchingImport) {
      const candidatePaths = rustImportCandidatePaths(matchingImport.importText, receiver, ctx.callerFile, ctx);
      if (candidatePaths === null) return CONTINUE;
      const candidates = ctx.symbolTable
        .lookupByShortName(call.member, { kinds: capability.codegraph.symbolKindRoles.callee })
        .filter((def) => candidatePaths.includes(def.relPath) && def.relPath.endsWith(".rs"));
      const reexport = this.resolveReexport(call, matchingImport.importText, receiver, ctx);
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

  private resolveReexport(
    call: CallRef,
    importText: string,
    receiver: string,
    ctx: CallContext,
  ): { targetRelPath: string; targetSymbolId: string } | null {
    const parsed = parseRustImportPath(importText, receiver);
    if (!parsed || ctx.moduleReexports === undefined) return null;
    const ownerSegments = parsed.sourceName === null ? parsed.moduleSegments.slice(0, -1) : parsed.moduleSegments;
    const exportedName = parsed.sourceName === null ? (parsed.moduleSegments.at(-1) ?? receiver) : parsed.sourceName;
    const ownerPaths = rustPathCandidatePaths(parsed, ownerSegments, ctx.callerFile, ctx);
    const candidates: { targetRelPath: string; targetSymbolId: string }[] = [];
    const visited = new Set<string>();
    const visit = (moduleFile: string, name: string, depth: number): void => {
      const key = `${moduleFile}::${name}`;
      if (depth > 3 || visited.has(key)) return;
      visited.add(key);
      for (const entry of ctx.moduleReexports?.[moduleFile] ?? []) {
        if (entry.exportedName !== name && entry.exportedName !== "*") continue;
        const sourceBinding = rustImportBindings(entry.sourceModule)?.[0];
        if (!sourceBinding) continue;
        const sourcePaths = rustPathCandidatePaths(sourceBinding, sourceBinding.moduleSegments, ctx.callerFile, ctx);
        if (entry.sourceName !== undefined) {
          sourcePaths.push(
            ...rustPathCandidatePaths(
              sourceBinding,
              [...sourceBinding.moduleSegments, entry.sourceName],
              ctx.callerFile,
            ),
          );
        }
        const targetName = call.receiver ? call.member : (entry.sourceName ?? name);
        for (const sourceFile of [...new Set(sourcePaths)]) {
          const defs = ctx.symbolTable
            .lookupByShortName(targetName, {
              kinds: capability.codegraph.symbolKindRoles.callee,
            })
            .filter((def) => def.relPath === sourceFile && def.relPath.endsWith(".rs"));
          for (const def of defs) candidates.push({ targetRelPath: def.relPath, targetSymbolId: def.symbolId });
          visit(sourceFile, entry.sourceName ?? name, depth + 1);
        }
      }
    };
    for (const ownerFile of ownerPaths) visit(ownerFile, exportedName, 0);
    const unique = [...new Map(candidates.map((candidate) => [candidate.targetRelPath, candidate])).values()];
    return unique.length === 1 ? unique[0] : null;
  }
}
