import { CONTINUE, resolved } from "../../../../../contracts/resolution.js";
import { pickSingleCandidate, type CallContext, type CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { mapPythonImportToFile } from "../python-path-mapper.js";
import { pythonImportMatchesReceiver, type ResolverConfig } from "./shared.js";

/**
 * Receiver-matches-import — find the `import` whose last module segment matches
 * the receiver name (handles both `import foo` and `from a.b import …` because
 * the trailing segment is what becomes the locally-bound name); map the module
 * path to a file via `mapPythonImportToFile`; then look up the member in the
 * symbol table restricted to that file. On a match emit the method-level edge;
 * when the file maps but no symbol matches by short-name, emit a terminal
 * file-only edge so the file-edge still gets attribution. On miss (no import
 * matches the receiver, or the module path does not map to a file) continue —
 * never a drop, it defers to the global short-name fallback.
 *
 * **The file-only edge stays a `resolved` commit, NOT a `deferred` park** (bd
 * tea-rags-mcp-86qfb, measured; contract in `contracts/resolution.ts`). This
 * pass is not a guard, so it genuinely preempts pass 6 — but pass 6 is
 * `globalShortName`, which carries no receiver evidence at all, and this pass
 * has already searched the mapped file for the member. A park can therefore
 * never be sharpened inside the parked file, only relocated out of it. Measured
 * with `scripts/codegraph-chain-tally.ts --lang python --defer importMatch`:
 * flask moved 2 edges (both right), a Django corpus moved 2 (both wrong —
 * `re.match` off the phantom `re.py` onto an unrelated in-project `match`),
 * zero same-file upgrades on either. Net zero, with a new false-positive
 * channel for stdlib receivers. Revisiting means gating the park on "the mapped
 * file exists in the project", which the `GlobalSymbolTable` contract cannot
 * answer today.
 */
export class PythonImportMatchSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "importMatch";
  constructor(private readonly cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (!call.receiver) return CONTINUE;
    const { receiver } = call;
    const match = ctx.imports.find((imp) => pythonImportMatchesReceiver(imp.importText, receiver));
    if (match) {
      const targetFile = mapPythonImportToFile(match.importText, ctx.callerFile);
      if (targetFile) {
        const candidates = ctx.symbolTable.lookupByShortName(call.member).filter((def) => def.relPath === targetFile);
        const target = pickSingleCandidate(candidates, this.cfg.mode);
        if (target) return resolved({ targetRelPath: target.relPath, targetSymbolId: target.symbolId });
        return resolved({ targetRelPath: targetFile, targetSymbolId: null });
      }
    }
    return CONTINUE;
  }
}
