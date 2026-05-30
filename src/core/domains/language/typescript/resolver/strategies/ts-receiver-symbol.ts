import { CONTINUE, resolved } from "../../../../../contracts/resolution.js";
import { pickSingleCandidate, type CallContext, type CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { collectImportedFiles, type ResolverConfig } from "./shared.js";

/**
 * Symbol-table FQN narrowing (bd tea-rags-mcp-kiuw). When basename normalize
 * fails (filename unrelated to class name, multi-export file, arbitrary
 * aliasing), discover the owning file by treating the receiver itself as a
 * symbol. For each imported file, check if any definition with
 * `fqName === receiver` lives there. The intersection picks the single file
 * that imports AND declares the receiver as a top-level symbol. Then resolve
 * `member` within that file. Terminal once that single file is found.
 */
export class TSReceiverSymbolSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "receiverSymbol";
  constructor(private readonly cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (!call.receiver) return CONTINUE;
    const receiverHits = ctx.symbolTable.lookup(call.receiver);
    if (receiverHits.length === 0) return CONTINUE;

    const importedFiles = collectImportedFiles(ctx, this.cfg.tsOptions);
    const receiverFiles = new Set<string>();
    for (const hit of receiverHits) {
      if (importedFiles.has(hit.relPath)) receiverFiles.add(hit.relPath);
    }
    if (receiverFiles.size !== 1) return CONTINUE;

    const targetFile = receiverFiles.values().next().value as string;
    const candidates = ctx.symbolTable
      .lookupByShortName(call.member)
      .filter((def) => def.relPath === targetFile && def.scope[def.scope.length - 1] === call.receiver);
    const target = pickSingleCandidate(candidates, this.cfg.mode);
    if (target) return resolved({ targetRelPath: target.relPath, targetSymbolId: target.symbolId });
    // Method not indexed yet — file-only edge so fan-graph stays accurate even
    // when method-level pinning fails.
    return resolved({ targetRelPath: targetFile, targetSymbolId: null });
  }
}
