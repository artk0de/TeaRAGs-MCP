import { CONTINUE, DROP, resolved } from "../../../../../contracts/resolution.js";
import {
  pickSingleCandidate,
  resolveLocalBindingType,
  type CallContext,
  type CallRef,
  type SymbolResolutionTarget,
} from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { PythonImportFileMapper } from "../python-import-file-mapper.js";
import { mapPythonImportToFile } from "../python-path-mapper.js";
import {
  lastSegment,
  pythonTypeNameIsExternal,
  pythonTypeOwnsMembers,
  walkClassExtendsForMethod,
  type ResolverConfig,
} from "./shared.js";

/**
 * Walker-inferred local type — `var.method()` where `var` maps to a known class
 * via `var = ClassName(...)`, `var: ClassName`, or `def f(var: Cls)` in
 * `ctx.localBindings`. Resolution is CONSTRAINED to that class — ordered BEFORE
 * the import-receiver / global short-name passes so an unambiguous local type
 * wins. Mirrors the TS / Go `resolveByLocalType` contract.
 *
 * **Guard:** when the receiver IS locally bound but the method cannot be pinned
 * to the type's file, the outcome is DROP — never fall through to the heuristic
 * import / short-name paths. `resolveByLocalType` returns `null` ONLY when even
 * the type's file is unknown (the type is neither in the symbol table nor
 * reachable via an import); otherwise it always produces a target (method-level
 * or file-only). The DROP prevents attributing the call to an unrelated class
 * that happens to define `<member>` (the `serializer.is_valid()` false
 * positive).
 *
 * **The file-only target is NOT a `deferred` park** (bd tea-rags-mcp-86qfb,
 * measured). It looks like the shape the deferral contract was built for, but it
 * is not: `resolveByLocalType` returns it INSTEAD OF `null`, and `null` becomes
 * `DROP` one line below — so within this pass the choice is a file-only edge
 * versus NO edge, never "commit now vs let a later pass answer". The pass is
 * terminal either way, exactly like `ts-super`'s intra-strategy fallback.
 * Parking it would newly expose locally-bound receivers to passes 5 and 6, which
 * is the fall-through this guard exists to prevent — and does: measured with
 * `scripts/codegraph-chain-tally.ts --lang python --defer localBinding` against
 * the very project that produced the guard, a park reproduces the documented
 * false positive 68 times (`serializer.is_valid()` → `ConfirmationCode#is_valid`
 * in an unrelated domain), with zero same-file upgrades.
 */
export class PythonLocalBindingSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "localBinding";
  constructor(
    private readonly cfg: ResolverConfig,
    private readonly mapper: PythonImportFileMapper = new PythonImportFileMapper(),
  ) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (!call.receiver) return CONTINUE;
    const localType = resolveLocalBindingType(ctx.localBindings, call.receiver, call.startLine);
    if (!localType) return CONTINUE;
    const localTarget = this.resolveByLocalType(localType, call.member, ctx);
    // `null` means "we know the type but cannot pin the method to its file"
    // (type file unknown) — DROP, do not fall through to the heuristic paths.
    return localTarget ? resolved(localTarget) : DROP;
  }

  /**
   * Look up `<typeName>.<member>` from the walker's local-binding
   * inference. Strategy:
   *   1. Resolve `typeName` to a file via the receiver-matches-import
   *      check on the bare class name (last segment for qualified
   *      types like `module.ClassName`).
   *   2. Within that file's symbols, look for `<member>` as a method.
   *   3. If the type's import isn't found, broaden: look for ANY
   *      symbol in the table whose shortName matches the bare type
   *      name AND has scope ending in that type — the symbol file
   *      becomes the target.
   *   4. If the target file is identified but `<member>` is not in
   *      it, return a partial edge (file-only) so the file-level fan
   *      remains accurate even when the method is inherited from a
   *      base class outside the project (DRF `is_valid` on
   *      `Serializer`).
   *   5. Return `null` only when even the type's file is unknown.
   */
  private resolveByLocalType(typeName: string, member: string, ctx: CallContext): SymbolResolutionTarget | null {
    // Bare class — `ToggleReactionSerializer`. Resolve via the import
    // list: walker either imported the class directly (`from x import
    // ToggleReactionSerializer`) or as a module path that ends in the
    // class name (rare).
    const bareType = lastSegment(typeName);
    const targetFile = resolveTypeFile(bareType, ctx, this.mapper, member);
    if (!targetFile) return null;

    const candidates = ctx.symbolTable
      .lookupByShortName(member)
      .filter((def) => def.relPath === targetFile && def.scope[def.scope.length - 1] === bareType);
    const target = pickSingleCandidate(candidates, this.cfg.mode);
    if (target) return { targetRelPath: target.relPath, targetSymbolId: target.symbolId };
    // bd tea-rags-mcp-yrs0 — `member` is not defined on the bound class
    // itself. Walk the bound class's IN-PROJECT base chain (`classExtends`)
    // before giving up: an inherited method like `Leaf().shared()` where
    // `shared` lives on `Base` resolves to `Base#shared`. The walk starts
    // one level up (the bound class was already checked above) and stops
    // at the first ancestor that defines the method.
    const parent = ctx.classExtends?.[bareType];
    if (parent) {
      const inherited = walkClassExtendsForMethod(parent, member, ctx, this.cfg.mode);
      if (inherited) return inherited;
    }
    // The class itself lives in `targetFile` but `member` is inherited
    // from a base OUTSIDE the project (DRF `is_valid` on `Serializer`) —
    // record the file-level attribution so the file-edge stays accurate;
    // drop the method-level edge by passing a null symbol id.
    return { targetRelPath: targetFile, targetSymbolId: null };
  }
}

/**
 * Find the file path of a bare class name by walking the import list.
 * Two shapes match:
 *   - `from <module> import <Bare>` — importText is `<module>`; the
 *     class name appears in the symbol table at the file `<module>`
 *     resolves to.
 *   - `import <module>` where `<module>` ends in the bare type name.
 *
 * Returns the file path of the class definition when an import
 * resolves there, or `null` otherwise.
 *
 * Both import-consulting passes go through `PythonImportFileMapper` (bd
 * tea-rags-mcp-9fgdi): membership in the symbol table, never a path synthesised
 * from the module text. An `external` verdict contributes NOTHING — attributing
 * a type to `rest_framework/serializers.py` is the phantom this seam removes.
 * An `unknown` verdict keeps the pre-seam fallback, per decision 1 of
 * `docs/superpowers/plans/2026-09-08-python-import-file-mapper.md`: three
 * states exist precisely so "I cannot tell" and "I know it is a library" behave
 * differently.
 *
 * `member` is the member being resolved ON the type, and it is what lets the
 * short-name pass tell a class from a same-named `def` (bd tea-rags-mcp-lbtmm)
 * — see {@link pythonTypeOwnsMembers}. Optional: the cone locator asks about a
 * TYPE with no call in hand, and omitting it leaves that caller's answers
 * exactly as they were.
 */
export function resolveTypeFile(
  bareType: string,
  ctx: CallContext,
  mapper: PythonImportFileMapper,
  member?: string,
): string | null {
  // An import-bound name the mapper calls EXTERNAL is a library class, and no
  // project file declares it. Deciding that FIRST is what stops the short-name
  // pass below from answering with a namesake: `from datetime import datetime`
  // in 53 polar files, against polar's own `def datetime(value)` in
  // `server/polar/backoffice/formatters.py` (bd tea-rags-mcp-lbtmm).
  if (pythonTypeNameIsExternal(bareType, ctx, mapper)) return null;

  // First pass: scan symbol table for ANY definition matching the
  // bare type name. If it's unique we have the file directly — provided the
  // match can OWN a member at all, which a top-level `def` cannot.
  const tableMatches = ctx.symbolTable.lookupByShortName(bareType);
  if (tableMatches.length === 1) {
    return pythonTypeOwnsMembers(bareType, member, ctx) ? tableMatches[0].relPath : null;
  }

  // Second pass: try to disambiguate via imports — the class file
  // must be one of the files reachable from the caller's imports. Only a
  // `project` verdict names a file the table can hold, so it is the only one
  // that can narrow the candidates.
  if (tableMatches.length > 1) {
    const importedFiles = new Set<string>();
    for (const imp of ctx.imports) {
      const mapped = mapper.mapImportToFile(imp.importText, ctx.callerFile, ctx);
      if (mapped.kind === "project") importedFiles.add(mapped.relPath);
    }
    const filtered = tableMatches.filter((def) => importedFiles.has(def.relPath));
    if (filtered.length === 1) return filtered[0].relPath;
    // Still ambiguous — refuse to guess.
    return null;
  }

  // Third pass: bare type not in symbol table (defined outside the
  // project — e.g. DRF Serializer). Walk imports: if any import path
  // ends in the type name and maps to a file, attribute to that.
  for (const imp of ctx.imports) {
    if (lastSegment(imp.importText) !== bareType) continue;
    const mapped = mapper.mapImportToFile(imp.importText, ctx.callerFile, ctx);
    if (mapped.kind === "project") return mapped.relPath;
    if (mapped.kind === "external") continue;
    const file = mapPythonImportToFile(imp.importText, ctx.callerFile);
    if (file) return file;
  }
  return null;
}
