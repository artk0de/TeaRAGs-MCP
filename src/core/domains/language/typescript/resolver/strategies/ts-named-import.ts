import { CONTINUE, resolved } from "../../../../../contracts/resolution.js";
import { pickSingleCandidate, type CallContext, type CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { mapImportToFile } from "../ts-path-mapper.js";
import type { ResolverConfig } from "./shared.js";

/**
 * EXACT named-specifier match (bd tea-rags-mcp-2v16). The walker records the
 * local binding names each import introduces in `ImportRef.importedNames`
 * (`import { RankModule } from "./m"` → `["RankModule"]`). When the receiver is
 * one of those names we know its source module precisely — no filename
 * heuristic needed. This supersedes the kebab→Pascal basename hack for any
 * import that carries `importedNames`. Within the matched file we FQN-narrow
 * (`scope[-1] === receiver`) before short-name so multi-export modules pin the
 * right class.
 *
 * Once the target FILE resolves this strategy is TERMINAL — even when the
 * member is not indexed it returns a file-only edge (`targetSymbolId: null`),
 * never continuing to a later pass.
 */
export class TSNamedImportSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "namedImport";
  constructor(private readonly cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (!call.receiver) return CONTINUE;
    const named = ctx.imports.find((imp) => imp.importedNames?.includes(call.receiver as string));
    if (!named) return CONTINUE;

    const targetFile = mapImportToFile(named.importText, ctx.callerFile, this.cfg.tsOptions);
    if (!targetFile) return CONTINUE;

    const scopedCandidates = ctx.symbolTable
      .lookupByShortName(call.member)
      .filter((def) => def.relPath === targetFile && def.scope[def.scope.length - 1] === call.receiver);
    const scopedHit = pickSingleCandidate(scopedCandidates, this.cfg.mode);
    if (scopedHit) return resolved({ targetRelPath: scopedHit.relPath, targetSymbolId: scopedHit.symbolId });

    const candidates = ctx.symbolTable.lookupByShortName(call.member).filter((def) => def.relPath === targetFile);
    const target = pickSingleCandidate(candidates, this.cfg.mode);
    if (target) return resolved({ targetRelPath: target.relPath, targetSymbolId: target.symbolId });

    return resolved({ targetRelPath: targetFile, targetSymbolId: null });
  }
}
