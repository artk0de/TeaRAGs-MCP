import { CONTINUE, DROP, resolved } from "../../../../../contracts/resolution.js";
import {
  pickSingleCandidate,
  type CallContext,
  type CallRef,
  type ImportRef,
} from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { reexportOriginFile } from "../../../kernel/reexport-origin.js";
import type { PythonImportFileMapper } from "../python-import-file-mapper.js";
import type { ResolverConfig } from "./shared.js";

/**
 * Imported-name resolution — the call's receiver, or a bare call's own name, is
 * a name an `import` statement BOUND (bd tea-rags-mcp-9fgdi).
 *
 * `from .models import Device` then `Device.objects`: the next pass down,
 * `importMatch`, matches a receiver against the import's LAST MODULE SEGMENT —
 * `models` — so it never considers `Device` at all, and the call falls to
 * `globalShortName`, which carries no receiver evidence whatsoever. The walker
 * now records what the statement actually bound (walker version 2), so this
 * pass reads the binding instead of guessing at it.
 *
 * CHAIN INDEX 5, after `localBinding` and before `importMatch`, and both halves
 * of that are correctness arguments:
 *
 *   - AFTER `localBinding`: a walker-bound local type is narrower evidence than
 *     an import binding (the variable was assigned in this body), and
 *     `localBinding` is a terminal guard whose DROP must keep preempting
 *     everything downstream. Running before it would resurrect the ugnest
 *     false-positive class the guards exist to kill.
 *   - BEFORE `importMatch`: `importMatch` guesses which name a statement bound
 *     from the module's trailing segment. This pass knows. Ordered the other
 *     way, the guess wins whenever both fire.
 *
 * Three outcomes, no fourth. `resolved` pins a symbol; `DROP` fires when the
 * binding names an EXTERNAL module, because a bare `loads(...)` after
 * `from json import loads` reaches the stdlib and falling through is exactly how
 * a project function of the same short name becomes a fabricated edge;
 * `CONTINUE` everywhere else, including every file walked by walker 1, whose
 * `ImportRef`s carry no binding channels at all.
 *
 * Never `deferred`: this pass either pins a symbol or has nothing to park.
 */
export class PythonImportedNameSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "importedName";

  constructor(
    private readonly cfg: ResolverConfig,
    private readonly mapper: PythonImportFileMapper,
  ) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    // A qualified call is keyed by its receiver's ROOT segment (`np.linalg.norm`
    // is bound through `np`); a bare call by the member itself.
    const localName = call.receiver ? call.receiver.split(".")[0] : call.member;
    const binding = findBinding(ctx.imports, localName);
    if (binding) return this.resolveBinding(binding, call, ctx);
    return this.resolveStarImport(call, ctx);
  }

  /**
   * The name is bound by an import. Map its module, then find the declaration:
   * in the mapped file, or — when the mapped file is a package `__init__.py`
   * that re-exports rather than declares — through one `reexportOriginFile`
   * hop, the same engine TypeScript uses for barrels.
   */
  private resolveBinding(binding: ImportBinding, call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    const mapped = this.mapper.mapImportToFile(binding.imp.importText, ctx.callerFile, ctx);
    if (mapped.kind === "external") return DROP;
    if (mapped.kind !== "project") return CONTINUE;

    // A qualified receiver (`Device.objects`) looks up `<importedName>.<member>`
    // and `<importedName>#<member>`; a bare call (`make_thing()`) looks up the
    // imported name itself. Python symbolIds carry no module path, so every
    // lookup is filtered to the mapped file.
    const declaringFile = this.declaringFile(binding.importedName, mapped.relPath, ctx);
    if (!declaringFile) return CONTINUE;

    const wanted = call.receiver
      ? [`${binding.importedName}.${call.member}`, `${binding.importedName}#${call.member}`]
      : [binding.importedName];
    for (const fqName of wanted) {
      const candidates = ctx.symbolTable.lookup(fqName).filter((def) => def.relPath === declaringFile);
      const target = pickSingleCandidate(candidates, this.cfg.mode);
      if (target) return resolved({ targetRelPath: target.relPath, targetSymbolId: target.symbolId });
    }
    return CONTINUE;
  }

  /**
   * Which file DECLARES `importedName`: the mapped file when it declares it
   * itself, otherwise the file it re-exports it from. `reexportOriginFile`
   * declines on an ambiguous or absent declaration, and so do we — an
   * ambiguous barrel beats a coin flip (bd tea-rags-mcp-ex28m).
   */
  private declaringFile(importedName: string, mappedFile: string, ctx: CallContext): string | null {
    const declaredHere = ctx.symbolTable.lookupByShortName(importedName).some((def) => def.relPath === mappedFile);
    if (declaredHere) return mappedFile;
    return reexportOriginFile(importedName, mappedFile, ctx, this.cfg.mode);
  }

  /**
   * `from .models import *` — netbox alone has 532 star imports and `__all__` in
   * 433 modules. No binding table exists (a star binds no single member), so the
   * question is where the member is DECLARED among what the star could have
   * brought in: the starred file itself, or, when the star targets a package,
   * any file under that package's directory.
   *
   * Unique declaration resolves; several CONTINUE. Guessing which module of a
   * starred package a name came from is what `__all__` would answer, and the
   * walker does not read it — that is a follow-up, not a coin flip.
   */
  private resolveStarImport(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    // Only bare calls: a star import binds names, never a receiver namespace.
    if (call.receiver) return CONTINUE;
    for (const imp of ctx.imports) {
      if (!imp.importedNames?.includes("*")) continue;
      const mapped = this.mapper.mapImportToFile(imp.importText, ctx.callerFile, ctx);
      if (mapped.kind !== "project") continue;
      const scope = packageScopeOf(mapped.relPath);
      const candidates = ctx.symbolTable
        .lookupByShortName(call.member)
        .filter((def) => def.relPath === mapped.relPath || (scope !== null && def.relPath.startsWith(scope)));
      const target = pickSingleCandidate(candidates, this.cfg.mode);
      if (target) return resolved({ targetRelPath: target.relPath, targetSymbolId: target.symbolId });
    }
    return CONTINUE;
  }
}

/** One import statement, the local name it bound, and the name the module exports. */
interface ImportBinding {
  imp: ImportRef;
  localName: string;
  importedName: string;
}

/**
 * The import that bound `localName`, with the name the MODULE exports it under.
 *
 * `importedBindings` is the authority (it survives aliasing);
 * `importedNames` alone means the statement bound the name unaliased, which is
 * the shape `from a import b` produces when a walker-1 file is mixed in.
 */
function findBinding(imports: readonly ImportRef[], localName: string): ImportBinding | null {
  for (const imp of imports) {
    const importedName = imp.importedBindings?.[localName];
    if (importedName) return { imp, localName, importedName };
  }
  for (const imp of imports) {
    if (imp.importedBindings) continue; // already consulted above; do not re-answer
    if (imp.importedNames?.includes(localName)) return { imp, localName, importedName: localName };
  }
  return null;
}

/**
 * The directory a starred PACKAGE covers, or `null` when the star targeted a
 * plain module. `dcim/models/__init__.py` covers `dcim/models/`; a star on
 * `app/models.py` covers only that file, which the caller already checks.
 */
function packageScopeOf(mappedFile: string): string | null {
  if (!mappedFile.endsWith("/__init__.py")) return null;
  return mappedFile.slice(0, mappedFile.length - "__init__.py".length);
}
