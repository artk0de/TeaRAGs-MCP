import { CONTINUE, DROP, resolved } from "../../../../../contracts/resolution.js";
import {
  pickSingleCandidate,
  type CallContext,
  type CallRef,
  type ImportRef,
  type SymbolResolutionTarget,
} from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { reexportOriginFile } from "../../../kernel/reexport-origin.js";
import { PYTHON_STDLIB_MODULES } from "../../vocabulary/stdlib-modules.js";
import type { PythonImportFileMapper } from "../python-import-file-mapper.js";
import type { ResolverConfig } from "./shared.js";

/**
 * A receiver this pass will answer: exactly ONE identifier. `Event.id.label()`,
 * `Job.objects.filter(…).delete()` and `Cls().method()` all reach here with a
 * receiver the old head-only `split(".")[0]` reduced to `Event` / `Job` / `Cls`
 * — dropping the middle hops and pinning a member the head never declared. Six
 * netbox rows and five polar rows were fabricated exactly that way, every one a
 * `phantom`. Folding hop by hop is `chainType`'s job; an import statement is
 * evidence about ONE name.
 */
const SINGLE_HOP_RECEIVER = /^[A-Za-z_][A-Za-z0-9_]*$/;

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
 * TWO receiver shapes, one binding table. `Device.objects` is a CLASS receiver:
 * the bound name is a symbol, and the member is `Device.objects` or
 * `Device#objects` inside the file that declares it. `columns.ColorColumn()` is
 * a MODULE receiver: no file declares `columns` as a symbol, because it is a
 * submodule, and the member is a top-level declaration of the file the composed
 * module text maps to. The receiver must be a SINGLE identifier for either —
 * a further hop is a fold, and folding is `chainType`'s pass, not this one.
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
    // Single hop only — see SINGLE_HOP_RECEIVER. Bare calls (`receiver: null`)
    // are unaffected, including the star-import path below.
    if (call.receiver !== null && !SINGLE_HOP_RECEIVER.test(call.receiver)) return CONTINUE;
    const localName = call.receiver ?? call.member;
    const binding = findBinding(ctx.imports, localName);
    if (binding) return this.resolveBinding(binding, call, ctx);
    return this.resolveStarImport(call, ctx);
  }

  /**
   * The name is bound by an import. Map its module, then find the declaration:
   * in the mapped file, or — when the mapped file is a package `__init__.py`
   * that re-exports rather than declares — through one `reexportOriginFile`
   * hop, the same engine TypeScript uses for barrels. A bound name that NO
   * file declares as a symbol is a module, and its member is looked up as a
   * top-level declaration inside it.
   */
  private resolveBinding(binding: ImportBinding, call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    // The stdlib check stays AHEAD of the mapper, the same way
    // `PythonExternalVocabulary.importLandsInProject` keeps it (bd
    // tea-rags-mcp-mmckn): the mapper probes the caller's ancestor directories
    // first, so `import json` from `netbox/utilities/forms/fields/fields.py`
    // lands on netbox's own `netbox/utilities/json.py` and 45 stdlib calls
    // become in-project phantoms. Absolute-import semantics settle it — a
    // project module of the same name is reachable through a relative or
    // package-qualified import, never through bare `import json`.
    if (importsStdlibModule(binding.imp.importText)) return DROP;

    const mapped = this.mapper.mapImportToFile(binding.imp.importText, ctx.callerFile, ctx);
    if (mapped.kind === "external") return DROP;
    if (mapped.kind === "project") {
      const declaringFile = this.declaringFile(binding.importedName, mapped.relPath, ctx);
      if (declaringFile) return this.resolveDeclaredName(binding, declaringFile, call, ctx);
    }
    return this.resolveModuleReceiver(binding, call, ctx);
  }

  /**
   * The bound name IS a symbol, declared in `declaringFile`. A qualified
   * receiver looks up `<importedName>.<member>` — the classmethod / staticmethod
   * spelling — then `<importedName>#<member>`, the instance one; a bare call
   * looks up the imported name itself. Python symbolIds carry no module path,
   * so every lookup is filtered to the declaring file.
   */
  private resolveDeclaredName(
    binding: ImportBinding,
    declaringFile: string,
    call: CallRef,
    ctx: CallContext,
  ): SymbolResolutionOutcome {
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
   * The receiver names a MODULE — `columns.ColorColumn()` under
   * `from netbox.tables import columns`, 435 of netbox's 437 `wrongFile` rows.
   *
   * The composed module text is mapped INSTEAD of the parent, not after it:
   * `from netbox import denormalized` has a parent the mapper calls `unknown`
   * (a PEP 420 namespace directory has no `__init__.py` to name), and only
   * `netbox.denormalized` resolves to a file. 52 more netbox rows are that
   * shape.
   *
   * Only `project` answers here; `external` CONTINUEs rather than DROPping,
   * which is where this differs from `resolveBinding` above. The DROP contract
   * is about a binding that names a LIBRARY, and every such binding has already
   * left through the stdlib guard or the import-text mapping — so by the time
   * the composed text is asked, `mapAbsolute` can only be answering its
   * RESIDUAL `external` ("no project file holds this"), which is exactly what
   * an ambiguously re-exported CLASS receiver produces: `from ui import Button`
   * declared in two files under `ui/` declines the barrel hop, falls through
   * here, and composes the non-module text `ui.Button`. DROPping that would
   * reverse the ex28m rule that an ambiguous barrel beats a coin flip.
   */
  private resolveModuleReceiver(binding: ImportBinding, call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (!call.receiver) return CONTINUE; // a bare call names no module
    const mapped = this.mapper.mapImportToFile(receiverModuleText(binding), ctx.callerFile, ctx);
    if (mapped.kind !== "project") return CONTINUE;
    const target = this.moduleMemberTarget(call.member, mapped.relPath, ctx);
    return target ? resolved(target) : CONTINUE;
  }

  /**
   * `member` as a TOP-LEVEL declaration of `moduleFile`, or `null`.
   *
   * `lookup` is exact-symbolId, and only a top-level `def` / `class` carries
   * the bare name as its whole id — a method is `Cls#member` or `Cls.member`.
   * So this cannot reach inside a class the way `lookupByShortName` would, and
   * a module declaring the name twice yields two candidates and declines.
   */
  private moduleMemberTarget(member: string, moduleFile: string, ctx: CallContext): SymbolResolutionTarget | null {
    const candidates = ctx.symbolTable.lookup(member).filter((def) => def.relPath === moduleFile);
    const target = pickSingleCandidate(candidates, this.cfg.mode);
    return target ? { targetRelPath: target.relPath, targetSymbolId: target.symbolId } : null;
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

/**
 * Is this an ABSOLUTE import of a stdlib module? Relative text (`.models`) can
 * never name the stdlib and its first segment is empty, so it is excluded
 * rather than tested.
 */
function importsStdlibModule(importText: string): boolean {
  if (importText.startsWith(".")) return false;
  return PYTHON_STDLIB_MODULES.has(importText.split(".")[0]);
}

/**
 * The module text a single-identifier receiver denotes, from the two shapes
 * `collectPythonImports` records (`walker/walker.ts:499`).
 *
 * `importedBindings[local] === importText` IS the `import_statement` form —
 * there the recorded value is the MODULE PATH. An unaliased `import a.b` binds
 * the top package, so its head denotes `a`, not `a.b`; an aliased one denotes
 * the whole path. Everything else is `from M import name`, where the value is
 * an exported NAME and the receiver denotes the SUBMODULE `M.name` — joined
 * without a separator when `M` already ends in a dot, or `from . import c`
 * would compose `..c` and climb a package.
 */
function receiverModuleText(binding: ImportBinding): string {
  const { importText } = binding.imp;
  if (binding.importedName === importText) {
    const firstSegment = binding.importedName.split(".")[0];
    return binding.localName === firstSegment ? firstSegment : binding.importedName;
  }
  return importText.endsWith(".") ? `${importText}${binding.importedName}` : `${importText}.${binding.importedName}`;
}
