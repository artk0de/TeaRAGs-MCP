import {
  pickSingleCandidate,
  type CallContext,
  type RelPath,
  type SymbolResolutionTarget,
} from "../../../../../contracts/types/codegraph.js";
import type { ConeTypeLocator } from "../../../../../contracts/types/language.js";
import { resolveTypeFile } from "./python-local-binding.js";
import { lastSegment, type ResolverConfig } from "./shared.js";

/**
 * Python specifics for the generic `ConeDispatchResolver` (bd tea-rags-mcp-f10y,
 * N=2). Supplies the two language-specific cone primitives:
 *
 *   - `resolveTypeFile` — Python module/type resolution. Reuses the same
 *     `resolveTypeFile` helper the `python-local-binding` strategy uses
 *     (symbol-table lookup → import-set disambiguation → import-path fallback),
 *     reduced to the bare class name first (`lastSegment` strips a qualified
 *     `module.ClassName`).
 *   - `findDirectMethod` — scope-tail match against the symbol table using
 *     Python's `.` scope separator (a method-level override pin on the type's
 *     own file). Mirrors `RubyConeTypeLocator` but with Python conventions:
 *     scope tails are bare class names (the walker scopes methods by class
 *     name), so the override check is the same candidate filter the
 *     `python-local-binding` strategy applies for the direct-method case.
 *
 * The CHA algorithm itself (descendants ∩ override, K-threshold, cone /
 * poly-base policy, confidence) lives in the language-neutral engine; this
 * locator carries ONLY the Python naming/resolution conventions.
 */
export class PythonConeTypeLocator implements ConeTypeLocator {
  constructor(private readonly cfg: ResolverConfig) {}

  /** Resolve a (possibly qualified) Python type name to its declaring file, or null. */
  resolveTypeFile(typeName: string, ctx: CallContext): RelPath | null {
    return resolveTypeFile(lastSegment(typeName), ctx);
  }

  /**
   * Method-level pin of `<typeName>.<member>` declared DIRECTLY on `typeName`'s
   * own file (no ancestor walk — an override is a direct redefinition).
   * `null` when the type's file is unknown or the method isn't declared there.
   */
  findDirectMethod(typeName: string, member: string, ctx: CallContext): SymbolResolutionTarget | null {
    const bareType = lastSegment(typeName);
    const file = resolveTypeFile(bareType, ctx);
    if (!file) return null;
    const candidates = ctx.symbolTable.lookupByShortName(member).filter((def) => {
      if (def.relPath !== file) return false;
      const tail = def.scope[def.scope.length - 1];
      return tail === typeName || tail === bareType;
    });
    const target = pickSingleCandidate(candidates, this.cfg.mode);
    return target ? { targetRelPath: target.relPath, targetSymbolId: target.symbolId } : null;
  }
}
