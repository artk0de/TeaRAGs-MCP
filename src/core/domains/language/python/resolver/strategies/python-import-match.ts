import { CONTINUE, resolved } from "../../../../../contracts/resolution.js";
import { pickSingleCandidate, type CallContext, type CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { PythonImportFileMapper } from "../python-import-file-mapper.js";
import { mapPythonImportToFile } from "../python-path-mapper.js";
import { findPythonImportBinding, pythonImportMatchesReceiver, type ResolverConfig } from "./shared.js";

/**
 * Receiver-matches-import — find the `import` whose last module segment matches
 * the receiver name (handles both `import foo` and `from a.b import …` because
 * the trailing segment is what becomes the locally-bound name); map the module
 * path to a file via the `PythonImportFileMapper`; then look up the member in the
 * symbol table restricted to that file. On a match emit the method-level edge;
 * when the file maps but no symbol matches by short-name, emit a terminal
 * file-only edge so the file-edge still gets attribution. On miss (no import
 * matches the receiver, or the module path does not map to a file) continue —
 * never a drop, it defers to the global short-name fallback.
 *
 * **DEMOTED on any receiver an import BOUND** (bd tea-rags-mcp-9fgdi).
 * `importedName`, one pass up, reads the walker's binding table; this pass
 * infers the bound name from a module's trailing segment, and the two disagree
 * exactly where the inference is wrong. Netbox measured it: of 517 answers here,
 * 437 were `wrongFile` and 45 `phantom` on receivers a binding covered, and not
 * one was a `match`. So the binding lookup now runs first and CONTINUEs, leaving
 * this pass the receivers nothing bound — star imports, a module-path segment
 * that merely looks like the receiver, dynamic attributes. Removing it outright
 * is a separate decision resting on that residual, not on symmetry.
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
 * channel for stdlib receivers. The park used to be gated on "the mapped file
 * exists in the project", which the `GlobalSymbolTable` contract could not
 * answer — it can now (`hasFile` / `hasFilesUnder`, bd tea-rags-mcp-9fgdi), and
 * this pass consumes that answer directly: an `external` verdict CONTINUES so
 * the external gate can classify the call out of the denominator instead of
 * committing a phantom edge. Re-measuring the park itself is still open.
 */
export class PythonImportMatchSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "importMatch";
  constructor(
    private readonly cfg: ResolverConfig,
    private readonly mapper: PythonImportFileMapper = new PythonImportFileMapper(),
  ) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (!call.receiver) return CONTINUE;
    const { receiver } = call;
    // Demoted on a receiver an import BOUND (bd tea-rags-mcp-9fgdi).
    // `importedName` runs one pass earlier and READS the binding table; this
    // pass GUESSES from a module's trailing segment, and on netbox that guess
    // is wrong every single time it fires on this shape — 437 `wrongFile` plus
    // 45 stdlib `phantom` out of 517 answers, and not one `match`. What is left
    // is receivers nothing bound: star imports, a module-path segment that
    // merely looks like the receiver, dynamic attributes — 35 rows on netbox.
    // Whole receiver, not its head: `pythonImportMatchesReceiver` compares a
    // single module segment against the entire receiver text, so a dotted
    // receiver never reaches the answer path anyway.
    if (findPythonImportBinding(ctx.imports, receiver) !== null) return CONTINUE;
    const match = ctx.imports.find((imp) => pythonImportMatchesReceiver(imp.importText, receiver));
    if (!match) return CONTINUE;

    const mapped = this.mapper.mapImportToFile(match.importText, ctx.callerFile, ctx);
    // EXTERNAL: `re.match(...)` after `import re`. The old code mapped it to the
    // phantom `re.py` and committed a file-only edge there — the measured source
    // of the Django corpus's two wrong moves (bd tea-rags-mcp-86qfb). Continue
    // instead, so `targetsExternalImport` classifies it out of the denominator.
    if (mapped.kind === "external") return CONTINUE;
    // UNKNOWN: no verdict, so keep the pre-seam behaviour exactly — including
    // the synthesised path, which is still the best guess available.
    const targetFile =
      mapped.kind === "project" ? mapped.relPath : mapPythonImportToFile(match.importText, ctx.callerFile);
    if (!targetFile) return CONTINUE;

    const candidates = ctx.symbolTable.lookupByShortName(call.member).filter((def) => def.relPath === targetFile);
    const target = pickSingleCandidate(candidates, this.cfg.mode);
    if (target) return resolved({ targetRelPath: target.relPath, targetSymbolId: target.symbolId });
    return resolved({ targetRelPath: targetFile, targetSymbolId: null });
  }
}
