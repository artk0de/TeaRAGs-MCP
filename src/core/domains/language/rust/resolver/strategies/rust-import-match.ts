import { CONTINUE, DROP, resolved } from "../../../../../contracts/resolution.js";
import { pickSingleCandidate, type CallContext, type CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { capability } from "../../capability.js";
import {
  parseRustImportPath,
  rustImportBindings,
  rustImportCandidatePaths,
  rustImportContainsReceiver,
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
      const reexport = this.resolveReexport(call, matchingImport.importText, call.member, ctx);
      return reexport ? resolved(reexport) : DROP;
    }
    const { receiver } = call;
    const matchingImport = ctx.imports.find((imp) => parseRustImportPath(imp.importText, receiver)?.receiverMatches);
    if (matchingImport) {
      const candidatePaths = rustImportCandidatePaths(matchingImport.importText, receiver, ctx.callerFile);
      if (candidatePaths === null) return CONTINUE;
      const candidates = ctx.symbolTable
        .lookupByShortName(call.member, { kinds: capability.codegraph.symbolKindRoles.callee })
        .filter((def) => candidatePaths.includes(def.relPath) && def.relPath.endsWith(".rs"));
      const reexport = this.resolveReexport(call, matchingImport.importText, receiver, ctx);
      if (reexport) return resolved(reexport);
      const target = pickSingleCandidate(candidates, this.cfg.mode);
      if (target) return resolved({ targetRelPath: target.relPath, targetSymbolId: target.symbolId });
      return DROP;
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
    const ownerPaths = rustPathCandidatePaths(parsed.prefix, ownerSegments, ctx.callerFile);
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
        const sourcePaths = rustPathCandidatePaths(sourceBinding.prefix, sourceBinding.moduleSegments, ctx.callerFile);
        if (entry.sourceName !== undefined) {
          sourcePaths.push(
            ...rustPathCandidatePaths(
              sourceBinding.prefix,
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
