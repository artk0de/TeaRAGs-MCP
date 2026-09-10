import { CONTINUE, DROP, resolved } from "../../../../../contracts/resolution.js";
import {
  pickSingleCandidate,
  type CallContext,
  type CallRef,
  type SymbolResolutionTarget,
} from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { reexportOriginFile } from "../../../kernel/reexport-origin.js";
import { PYTHON_STDLIB_MODULES } from "../../vocabulary/stdlib-modules.js";
import type { PythonAncestorLinearizerCache } from "../python-ancestor-policy.js";
import type { PythonImportFileMapper } from "../python-import-file-mapper.js";
import {
  findPythonImportBinding,
  pythonClassKey,
  resolvePythonInheritedMember,
  type PythonImportBinding,
  type ResolverConfig,
} from "./shared.js";

/**
 * A receiver this pass will answer: exactly ONE identifier. `Event.id.label()`,
 * `Job.objects.filter(…).delete()` and `Cls().method()` all reach here with a
 * receiver the old head-only `split(".")[0]` reduced to `Event` / `Job` / `Cls`
 * — dropping the middle hops and pinning a member the head never declared. Six
 * netbox rows and five polar rows were fabricated exactly that way, every one a
 * `phantom`. Folding hop by hop is `chainType`'s job; an import statement is
 * evidence about ONE name.
 *
 * It gates RESOLUTION, not the whole pass. A receiver it rejects still has a
 * HEAD, and an external head is still a refusal this pass owns — see
 * `multiHopHeadOutcome` (bd tea-rags-mcp-cnco6).
 */
const SINGLE_HOP_RECEIVER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * A receiver that is nothing but MODULE TEXT: two or more lowercase segments,
 * no call, no capitalized hop. PEP 8 spells modules lowercase and classes
 * CamelCase, and the capital is what keeps `Event.id` — a SQLAlchemy column on
 * a class, whose fold `chainType` owns — out of {@link
 * PythonImportedNameSymbolResolutionStrategy.resolveDottedModuleReceiver}.
 */
const DOTTED_MODULE_RECEIVER = /^[a-z_]\w*(\.[a-z_]\w*)+$/;

/**
 * Imported-name resolution — the call's receiver, or a bare call's own name, is
 * a name an `import` statement BOUND (bd tea-rags-mcp-9fgdi).
 *
 * `from .models import Device` then `Device.objects`: the pass that used to sit
 * below this one, `importMatch`, matched a receiver against the import's LAST
 * MODULE SEGMENT — `models` — so it never considered `Device` at all, and the
 * call fell to `globalShortName`, which carries no receiver evidence whatsoever.
 * The walker now records what the statement actually bound (walker version 2),
 * so this pass reads the binding instead of guessing at it. The guessing pass is
 * gone (bd tea-rags-mcp-rw1qk).
 *
 * CHAIN INDEX 5, after `localBinding` and last before `globalShortName`, and
 * both halves of that are correctness arguments:
 *
 *   - AFTER `localBinding`: a walker-bound local type is narrower evidence than
 *     an import binding (the variable was assigned in this body), and
 *     `localBinding` is a terminal guard whose DROP must keep preempting
 *     everything downstream. Running before it would resurrect the ugnest
 *     false-positive class the guards exist to kill.
 *   - BEFORE `globalShortName`: the fallback carries no receiver evidence at
 *     all. This pass knows what the statement bound, so it must claim the call
 *     first or the evidence is thrown away.
 *
 * Three outcomes, no fourth. `resolved` pins a symbol; `DROP` fires when the
 * binding names an EXTERNAL module, because a bare `loads(...)` after
 * `from json import loads` reaches the stdlib and falling through is exactly how
 * a project function of the same short name becomes a fabricated edge;
 * `CONTINUE` everywhere else, including every file walked by walker 1, whose
 * `ImportRef`s carry no binding channels at all.
 *
 * THREE receiver shapes, one binding table, tried in order and each falling to
 * the next on a decline. `Device.objects` is a CLASS receiver: the bound name is
 * a symbol, and the member is `Device.objects` or `Device#objects` inside the
 * file that declares it. `columns.ColorColumn()` is a MODULE receiver: no file
 * declares `columns` as a symbol, because it is a submodule, and the member is a
 * top-level declaration of the file the composed module text maps to.
 * `client.query()` after `from .client import client` is a module-level VALUE:
 * neither a symbol nor a submodule, so the import statement's own file is the
 * only evidence and the member is looked up inside it by short name.
 *
 * The receiver must be a SINGLE identifier for all three — a further hop is a
 * fold, and folding is `chainType`'s pass, not this one. What a multi-hop
 * receiver still gets is the EXTERNAL verdict on its head, which is a refusal
 * rather than a resolution; see {@link
 * PythonImportedNameSymbolResolutionStrategy.multiHopHeadOutcome}.
 *
 * Never `deferred`: this pass either pins a symbol or has nothing to park.
 */
export class PythonImportedNameSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "importedName";

  constructor(
    private readonly cfg: ResolverConfig,
    private readonly mapper: PythonImportFileMapper,
    private readonly linearizers?: PythonAncestorLinearizerCache,
  ) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    // Single hop only — see SINGLE_HOP_RECEIVER. A further hop is a FOLD, but
    // the fold verdict is not the same question as the EXTERNAL one, so the
    // multi-hop receiver goes through its own head check rather than CONTINUEing
    // blind. Bare calls (`receiver: null`) are unaffected, including the
    // star-import path below.
    if (call.receiver !== null && !SINGLE_HOP_RECEIVER.test(call.receiver)) {
      const asModulePath = this.resolveDottedModuleReceiver(call.receiver, call, ctx);
      return asModulePath.kind === "resolved" ? asModulePath : this.multiHopHeadOutcome(call.receiver, ctx);
    }
    const localName = call.receiver ?? call.member;
    const binding = findPythonImportBinding(ctx.imports, localName);
    if (binding) return this.resolveBinding(binding, call, ctx);
    const sameFile = this.resolveSameFileClassReceiver(call, ctx);
    if (sameFile.kind === "resolved") return sameFile;
    return this.resolveStarImport(call, ctx);
  }

  /**
   * The receiver is a class the CALLER'S OWN FILE declares, so no import bound
   * it and the binding table above had nothing to say (bd tea-rags-mcp-99t5y).
   *
   * This pass owns the class-receiver question — `resolveDeclaredName` asks it
   * of an imported class — and a same-file class is the same question with the
   * declaring file already in hand. It used to be answered one pass later, by
   * `globalShortName` searching the member's bare short name, and that pass no
   * longer speaks about receiver-bound calls at all. ugnest's `constant` bucket
   * is exactly this shape: all 27 of its `globalShortName` matches are
   * `Cls.method()` with class and method in the calling file, and the 2 phantoms
   * beside them (`SHORT_HEX_RE.match(color)` → an unrelated
   * `DistrictMatcher#match`) are the shape this declines.
   *
   * The gate IS the evidence: `<receiver>.<member>` (classmethod / staticmethod)
   * or `<receiver>#<member>` (instance) must be an EXACT symbolId declared in
   * `ctx.callerFile`. Python symbolIds carry no module path, so the file filter
   * is what makes it the caller's own class; and no top-level `def` can spell a
   * dotted id, so the lookup cannot reach anything but a member of that class.
   * No short-name search, no MRO walk, no DROP — a miss CONTINUEs, and the only
   * pass below no longer answers it either.
   */
  private resolveSameFileClassReceiver(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (!call.receiver) return CONTINUE; // a bare call names no class
    for (const fqName of [`${call.receiver}.${call.member}`, `${call.receiver}#${call.member}`]) {
      const candidates = ctx.symbolTable.lookup(fqName).filter((def) => def.relPath === ctx.callerFile);
      const target = pickSingleCandidate(candidates, this.cfg.mode);
      if (target) return resolved({ targetRelPath: target.relPath, targetSymbolId: target.symbolId });
    }
    return CONTINUE;
  }

  /**
   * The whole receiver is MODULE TEXT — `utilities.fields.ColorField(...)` and
   * `core.models.object_types.ObjectTypeManager()` (R4b, bd tea-rags-mcp-jeqyg).
   *
   * `import utilities.fields` binds the TOP package, so the receiver spells a
   * module in two or three hops with no value anywhere in it: the chain fold
   * declines it by construction (`pythonSingleHopType` answers for `self`, a
   * constructor call and a local binding, and a module is none of the three)
   * and {@link multiHopHeadOutcome} only ever refused it. 100 netbox rows, 98
   * of them generated Django migrations.
   *
   * The evidence is a lookup rather than an inference, and all three gates must
   * hold: the head must be a name THIS FILE's import list bound, the composed
   * text must map to a PROJECT file, and that file must declare the member as a
   * unique top level. Compose from {@link receiverModuleText} rather than from
   * the receiver text, so `import a.b` (head denotes `a`) and `import a.b as c`
   * (head denotes `a.b`) stay one question rather than two.
   *
   * Tried BEFORE the head check and returning only `resolved`, so a head the
   * mapper calls external still reaches its DROP: a receiver whose module text
   * lands outside the project cannot resolve here either, and the refusal is
   * the stronger verdict. The stdlib guard is the one case where the ORDER
   * matters — `os.path` would land on a project `path.py` through the mapper's
   * ancestor probe, so this arm declines it and lets the head check DROP.
   */
  private resolveDottedModuleReceiver(receiver: string, call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (!DOTTED_MODULE_RECEIVER.test(receiver)) return CONTINUE;
    const segments = receiver.split(".");
    const binding = findPythonImportBinding(ctx.imports, segments[0]);
    if (binding === null || importsStdlibModule(binding.imp.importText)) return CONTINUE;
    const moduleText = [receiverModuleText(binding), ...segments.slice(1)].join(".");
    const mapped = this.mapper.mapImportToFile(moduleText, ctx.callerFile, ctx);
    if (mapped.kind !== "project") return CONTINUE;
    const target = this.moduleMemberTarget(call.member, mapped.relPath, ctx);
    return target ? resolved(target) : CONTINUE;
  }

  /**
   * A multi-hop receiver: only `DROP` or `CONTINUE`, decided by its HEAD
   * (bd tea-rags-mcp-cnco6).
   *
   * `ContentType.objects.filter(...)` under
   * `from django.contrib.contenttypes.models import ContentType` is not this
   * pass's to resolve — folding `.objects` is `chainType`'s job — but it is
   * this pass's to REFUSE, on exactly the evidence its single-hop sibling
   * refuses `ContentType.objects()` with: the head is bound to a module no
   * project file holds. CONTINUEing instead handed the call to
   * `globalShortName`, which carries no receiver evidence and answered with
   * whatever in-project `filter` it found — 95 phantoms on netbox, 9 on ugnest,
   * 2 on flask, every one `agreeExternal -> phantom`.
   *
   * The two verdicts that are NOT terminal:
   *   - a head the mapper calls `project` or `unknown`. `pkg.mod.func()` under
   *     `import pkg` is a real in-project chain, and folding it is owned by
   *     `chainType` and receiver-type propagation;
   *   - a head no import bound — including one that is not an identifier at all,
   *     which is what `helper(x).decode()` reaches the resolver as.
   */
  private multiHopHeadOutcome(receiver: string, ctx: CallContext): SymbolResolutionOutcome {
    const head = receiver.split(".")[0];
    if (!SINGLE_HOP_RECEIVER.test(head)) return CONTINUE;
    const binding = findPythonImportBinding(ctx.imports, head);
    if (binding === null) return CONTINUE;
    // The same two-step `resolveBinding` uses, and for the same reason: the
    // stdlib snapshot is a positive verdict the mapper's ancestor probe would
    // shadow with a project module of the same name.
    if (importsStdlibModule(binding.imp.importText)) return DROP;
    const mapped = this.mapper.mapImportToFile(binding.imp.importText, ctx.callerFile, ctx);
    return mapped.kind === "external" ? DROP : CONTINUE;
  }

  /**
   * The name is bound by an import. Map its module, then find the declaration:
   * in the mapped file, or — when the mapped file is a package `__init__.py`
   * that re-exports rather than declares — through one `reexportOriginFile`
   * hop, the same engine TypeScript uses for barrels. A bound name that NO
   * file declares as a symbol is a module, and its member is looked up as a
   * top-level declaration inside it.
   *
   * THREE arms, tried in order of how specific the evidence is, and a declining
   * arm falls to the next rather than ending the pass (bd tea-rags-mcp-cnco6).
   * Returning `resolveDeclaredName`'s CONTINUE directly is what cost polar 8
   * rows: `from . import pan_transfer` maps to the package `__init__.py`, and
   * the re-export hop pinned the package's own `async def pan_transfer` route
   * handler — the project's unique declaration of that bare name — so
   * `pan_transfer.build` found nothing on it and the module arm, which resolves,
   * was never asked.
   */
  private resolveBinding(binding: PythonImportBinding, call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
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
    const declaringFile =
      mapped.kind === "project" ? this.declaringFile(binding.importedName, mapped.relPath, ctx) : null;
    const declared = declaringFile === null ? CONTINUE : this.resolveDeclaredName(binding, declaringFile, call, ctx);
    if (declared.kind === "resolved") return declared;

    const asModule = this.resolveModuleReceiver(binding, call, ctx);
    if (asModule.kind === "resolved") return asModule;
    // The value arm's gate is whether the MAPPED file declares the bound name
    // ITSELF — `declaringFile === mapped.relPath`. A `declaringFile` that came
    // from the re-export HOP is not the same evidence: the hop asks which file
    // declares the bare name, and over polar's export-a-singleton idiom it
    // answers with whatever unrelated top-level `def` happens to spell it
    // (`benefit_grant = BenefitGrantService()` against the caller's own
    // `async def benefit_grant(...)`). The file the IMPORT names is still the
    // one to read the member out of.
    const asValue =
      mapped.kind === "project" && declaringFile !== mapped.relPath
        ? this.resolveModuleValueReceiver(mapped.relPath, call, ctx)
        : CONTINUE;
    if (asValue.kind === "resolved") return asValue;
    // The declared-name arm's DROP outranks every CONTINUE below it, but only
    // AFTER the sibling arms have been asked. It says the passes DOWNSTREAM
    // must not answer — `globalShortName` off a bare member name — and an arm
    // of this same pass reading its own evidence is not downstream. polar's
    // `from . import pan_transfer` is exactly the pair: the hop pins a
    // same-named top-level `def`, whose empty hierarchy reads CLOSED and DROPs,
    // while the module arm maps `.pan_transfer` to the file that declares the
    // member. 22 rows there, 18 more on the singleton shape above.
    return declared.kind === "continue" ? CONTINUE : declared;
  }

  /**
   * The bound name IS a symbol, declared in `declaringFile`. A qualified
   * receiver looks up `<importedName>.<member>` — the classmethod / staticmethod
   * spelling — then `<importedName>#<member>`, the instance one; a bare call
   * looks up the imported name itself. Python symbolIds carry no module path,
   * so every lookup is filtered to the declaring file.
   *
   * A CLASS receiver whose class does not declare the member gets one more
   * question asked of it: the class's MRO. polar's
   * `AccountRepository.from_session(...)` is `RepositoryBase.from_session`, and
   * that ONE shape is all 1,663 of polar's missed `constant` rows (bd
   * tea-rags-mcp-9fgdi). A hierarchy read to its end that still does not own
   * the member DROPs, because the only pass left below is `globalShortName`
   * and its answer would carry no receiver evidence at all; an `unknown`
   * boundary keeps today's CONTINUE.
   */
  private resolveDeclaredName(
    binding: PythonImportBinding,
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
    return call.receiver ? this.resolveInheritedMember(binding, declaringFile, call, ctx) : CONTINUE;
  }

  /** The class-receiver arm's ancestor fallback — see {@link resolveDeclaredName}. */
  private resolveInheritedMember(
    binding: PythonImportBinding,
    declaringFile: string,
    call: CallRef,
    ctx: CallContext,
  ): SymbolResolutionOutcome {
    const linearizer = this.linearizers?.for(ctx);
    if (linearizer === undefined) return CONTINUE;
    const classKey = pythonClassKey(declaringFile, binding.importedName);
    const { target, closure } = resolvePythonInheritedMember(classKey, call.member, ctx, this.cfg.mode, linearizer);
    if (target) return resolved(target);
    return closure === "unknown" ? CONTINUE : DROP;
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
  private resolveModuleReceiver(
    binding: PythonImportBinding,
    call: CallRef,
    ctx: CallContext,
  ): SymbolResolutionOutcome {
    if (!call.receiver) return CONTINUE; // a bare call names no module
    const mapped = this.mapper.mapImportToFile(receiverModuleText(binding), ctx.callerFile, ctx);
    if (mapped.kind !== "project") return CONTINUE;
    const target = this.moduleMemberTarget(call.member, mapped.relPath, ctx);
    return target ? resolved(target) : CONTINUE;
  }

  /**
   * The bound name is neither a declared symbol nor a submodule: it is a
   * module-level VALUE in `moduleFile` (bd tea-rags-mcp-cnco6).
   *
   * `from .client import client` where `client.py` ends in
   * `client = TinybirdClient(...)` — polar's export-a-singleton idiom, 23 rows,
   * and the shape `importMatch` used to answer by accident because the module
   * happens to share the singleton's name. `TinybirdClient` is what `client`
   * holds, but nothing pass 1 records says so: no symbol carries the name, and
   * `<pkg>.client.client` names no file. What the import statement DOES say is
   * which single file the value came from, and that file declares `query` once.
   *
   * Reached ONLY when both arms above have declined AND `moduleFile` does not
   * declare the bound name ITSELF, so a class receiver whose member is inherited
   * never lands here — searching its file by short name would answer with the
   * file's other class, and MRO owns that question. A `declaringFile` reached
   * through the re-export HOP does not close the gate: the hop answers "which
   * file declares this bare name", which over the singleton idiom is a
   * coincidence rather than the receiver's type. The one remaining gate is the
   * search itself: `lookupByShortName` is filtered to `moduleFile` and must come
   * back with exactly one definition, so a module holding two classes that both
   * spell the member declines rather than picking.
   */
  private resolveModuleValueReceiver(moduleFile: string, call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (!call.receiver) return CONTINUE; // a bare call names no value to read a member off
    const candidates = ctx.symbolTable.lookupByShortName(call.member).filter((def) => def.relPath === moduleFile);
    const target = pickSingleCandidate(candidates, this.cfg.mode);
    return target ? resolved({ targetRelPath: target.relPath, targetSymbolId: target.symbolId }) : CONTINUE;
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
    const direct = pickSingleCandidate(
      ctx.symbolTable.lookup(member).filter((def) => def.relPath === moduleFile),
      this.cfg.mode,
    );
    if (direct) return { targetRelPath: direct.relPath, targetSymbolId: direct.symbolId };
    // The module re-exports rather than declares — a package `__init__.py`
    // pulling `ColorColumn` out of its own `columns.py`. ONE hop, through the
    // same engine `declaringFile` uses two methods down, so the two questions
    // cannot drift apart. Its three gates do the declining: the name must be in
    // the table, `moduleFile` must not declare it, and the declaration must be
    // unique (retried inside the package on a global tie). The target module's
    // OWN `importedBindings` are not reachable from a `CallContext` — see the
    // helper's docblock — so declaration lookup is the mechanism, and it covers
    // `from .columns import *` for free.
    const origin = reexportOriginFile(member, moduleFile, ctx, this.cfg.mode);
    if (!origin) return null;
    const hopped = pickSingleCandidate(
      ctx.symbolTable.lookup(member).filter((def) => def.relPath === origin),
      this.cfg.mode,
    );
    return hopped ? { targetRelPath: hopped.relPath, targetSymbolId: hopped.symbolId } : null;
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
function receiverModuleText(binding: PythonImportBinding): string {
  const { importText } = binding.imp;
  if (binding.importedName === importText) {
    const firstSegment = binding.importedName.split(".")[0];
    return binding.localName === firstSegment ? firstSegment : binding.importedName;
  }
  return importText.endsWith(".") ? `${importText}${binding.importedName}` : `${importText}.${binding.importedName}`;
}
