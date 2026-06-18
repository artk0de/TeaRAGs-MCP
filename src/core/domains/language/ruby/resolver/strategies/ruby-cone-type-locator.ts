import {
  pickSingleCandidate,
  type CallContext,
  type RelPath,
  type SymbolResolutionTarget,
} from "../../../../../contracts/types/codegraph.js";
import type { ConeTypeLocator } from "../../../../../contracts/types/language.js";
import { lastConstantSegment, resolveConstant, type ResolverConfig } from "./shared.js";

/**
 * Ruby specifics for the generic `ConeDispatchResolver` (bd tea-rags-mcp-f10y).
 * Supplies the two language-specific cone primitives:
 *
 *   - `resolveTypeFile` — Zeitwerk / constant resolution (`resolveConstant`).
 *   - `findDirectMethod` — scope-tail / `::`-segment match against the symbol
 *     table (a method-level override pin on the type's own file).
 *
 * The CHA algorithm itself (descendants ∩ override, K-threshold, cone /
 * poly-base policy, confidence) lives in the language-neutral engine; this
 * locator carries ONLY the Ruby naming/resolution conventions.
 */
export class RubyConeTypeLocator implements ConeTypeLocator {
  constructor(private readonly cfg: ResolverConfig) {}

  /** Resolve a (possibly qualified) Ruby constant to its declaring file, or null. */
  resolveTypeFile(typeName: string, ctx: CallContext): RelPath | null {
    return resolveConstant(typeName, ctx);
  }

  /**
   * Method-level pin of `<typeName>#<member>` declared DIRECTLY on `typeName`'s
   * own file (no ancestor walk — an override is a direct redefinition).
   * `null` when the type's file is unknown or the method isn't declared there.
   */
  findDirectMethod(typeName: string, member: string, ctx: CallContext): SymbolResolutionTarget | null {
    const file = resolveConstant(typeName, ctx);
    if (!file) return null;
    const bareType = lastConstantSegment(typeName);
    const candidates = ctx.symbolTable.lookupByShortName(member).filter((def) => {
      if (def.relPath !== file) return false;
      const tail = def.scope[def.scope.length - 1];
      return tail === typeName || tail === bareType;
    });
    const target = pickSingleCandidate(candidates, this.cfg.mode);
    return target ? { targetRelPath: target.relPath, targetSymbolId: target.symbolId } : null;
  }
}
