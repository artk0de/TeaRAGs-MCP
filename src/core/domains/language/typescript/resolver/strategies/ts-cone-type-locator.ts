import {
  pickSingleCandidate,
  type CallContext,
  type RelPath,
  type SymbolResolutionTarget,
} from "../../../../../contracts/types/codegraph.js";
import type { ConeTypeLocator } from "../../../../../contracts/types/language.js";
import { mapImportToFile } from "../ts-path-mapper.js";
import { collectImportedFiles, type ResolverConfig } from "./shared.js";

/**
 * TypeScript specifics for the generic `ConeDispatchResolver` (bd
 * tea-rags-mcp-k4wpn). Supplies the two language-specific cone primitives the
 * language-neutral CHA engine needs:
 *
 *   - `resolveTypeFile` — map an interface / class type name to its declaring
 *     file. A unique short-name match in the symbol table resolves directly;
 *     when several files declare the name, the caller's import set (mapped
 *     through the tsconfig path mapper, mirroring `collectImportedFiles`)
 *     disambiguates. Refuses to guess when still ambiguous.
 *   - `findDirectMethod` — scope-tail match against the symbol table: a method
 *     declared DIRECTLY on `typeName`'s own file with a scope tail equal to the
 *     type (the override pin). Mirrors `PythonConeTypeLocator` with TS path-map
 *     conventions.
 *
 * The CHA algorithm itself (descendants ∩ override, K-threshold, cone /
 * poly-base policy, confidence) lives in the engine; this locator carries ONLY
 * the TypeScript naming / resolution conventions.
 */
export class TSConeTypeLocator implements ConeTypeLocator {
  constructor(private readonly cfg: ResolverConfig) {}

  /** Resolve a type name to its declaring file via symbol table + import disambiguation, or null. */
  resolveTypeFile(typeName: string, ctx: CallContext): RelPath | null {
    const matches = ctx.symbolTable.lookupByShortName(typeName).filter((def) => def.scope.length === 0);
    if (matches.length === 1) return matches[0].relPath;
    if (matches.length > 1) {
      const importedFiles = collectImportedFiles(ctx, this.cfg.tsOptions);
      const filtered = matches.filter((def) => importedFiles.has(def.relPath));
      if (filtered.length === 1) return filtered[0].relPath;
      return null;
    }
    // Type not declared in-project: a same-named import whose specifier maps to
    // a project file anchors it (rare — interfaces are usually in-project).
    for (const imp of ctx.imports) {
      if (!imp.importedNames?.includes(typeName)) continue;
      const file = mapImportToFile(imp.importText, ctx.callerFile, this.cfg.tsOptions);
      if (file) return file;
    }
    return null;
  }

  /**
   * Method-level pin of `<typeName>.<member>` declared DIRECTLY on `typeName`'s
   * own file (no ancestor walk — an override is a direct redefinition).
   * `null` when the type's file is unknown or the method isn't declared there.
   */
  findDirectMethod(typeName: string, member: string, ctx: CallContext): SymbolResolutionTarget | null {
    const file = this.resolveTypeFile(typeName, ctx);
    if (!file) return null;
    const candidates = ctx.symbolTable.lookupByShortName(member).filter((def) => {
      if (def.relPath !== file) return false;
      return def.scope[def.scope.length - 1] === typeName;
    });
    const target = pickSingleCandidate(candidates, this.cfg.mode);
    return target ? { targetRelPath: target.relPath, targetSymbolId: target.symbolId } : null;
  }
}
