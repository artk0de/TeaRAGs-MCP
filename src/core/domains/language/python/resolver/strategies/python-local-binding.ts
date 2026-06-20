import { CONTINUE, DROP, resolved } from "../../../../../contracts/resolution.js";
import {
  pickSingleCandidate,
  resolveLocalBindingType,
  type CallContext,
  type CallRef,
  type SymbolResolutionTarget,
} from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { mapPythonImportToFile } from "../python-path-mapper.js";
import { lastSegment, walkClassExtendsForMethod, type ResolverConfig } from "./shared.js";

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
 */
export class PythonLocalBindingSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "localBinding";
  constructor(private readonly cfg: ResolverConfig) {}

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
    const targetFile = resolveTypeFile(bareType, ctx);
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
 */
export function resolveTypeFile(bareType: string, ctx: CallContext): string | null {
  // First pass: scan symbol table for ANY definition matching the
  // bare type name. If it's unique we have the file directly.
  const tableMatches = ctx.symbolTable.lookupByShortName(bareType);
  if (tableMatches.length === 1) return tableMatches[0].relPath;

  // Second pass: try to disambiguate via imports — the class file
  // must be one of the files reachable from the caller's imports.
  if (tableMatches.length > 1) {
    const importedFiles = new Set<string>();
    for (const imp of ctx.imports) {
      const file = mapPythonImportToFile(imp.importText, ctx.callerFile);
      if (file) importedFiles.add(file);
    }
    const filtered = tableMatches.filter((def) => importedFiles.has(def.relPath));
    if (filtered.length === 1) return filtered[0].relPath;
    // Still ambiguous — refuse to guess.
    return null;
  }

  // Third pass: bare type not in symbol table (defined outside the
  // project — e.g. DRF Serializer). Walk imports: if any import path
  // ends in the type name and resolves to a file, attribute to that.
  for (const imp of ctx.imports) {
    if (lastSegment(imp.importText) !== bareType) continue;
    const file = mapPythonImportToFile(imp.importText, ctx.callerFile);
    if (file) return file;
  }
  return null;
}
