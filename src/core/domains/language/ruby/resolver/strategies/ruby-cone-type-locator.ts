import {
  pickSingleCandidate,
  type CallContext,
  type RelPath,
  type SymbolResolutionTarget,
} from "../../../../../contracts/types/codegraph.js";
import type { ConeTypeLocator } from "../../../../../contracts/types/language.js";
import { lastConstantSegment, lookupRubySymbolsByShortName, resolveConstant, type ResolverConfig } from "./shared.js";

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
    const candidates = lookupRubySymbolsByShortName(ctx, member, { role: "callee" }).filter((def) => {
      if (def.relPath !== file) return false;
      const tail = def.scope[def.scope.length - 1];
      return tail === typeName || tail === bareType;
    });
    const target = pickSingleCandidate(candidates, this.cfg.mode);
    return target ? { targetRelPath: target.relPath, targetSymbolId: target.symbolId } : null;
  }

  /**
   * Could `typeName` name a project class or module (bd tea-rags-mcp-0qaht.64)?
   * True when the constant resolves, or when any Ruby class / module (or a
   * definition carrying no kind) ends with `typeName`'s segments — so a
   * constant written relative to a lexical namespace still counts. False only
   * when nothing in the project could be meant: a gem class like
   * `Rack::Response`, which `Sinatra::Response` extends.
   */
  isProjectType(typeName: string, ctx: CallContext): boolean {
    if (resolveConstant(typeName, ctx)) return true;
    const segments = typeName.replace(/^::/, "").split("::");
    return lookupRubySymbolsByShortName(ctx, lastConstantSegment(typeName)).some((def) => {
      if (def.symbolKind !== undefined && def.symbolKind !== "class" && def.symbolKind !== "module") return false;
      const path = [...def.scope, def.shortName];
      return segments.every((segment, i) => path[path.length - segments.length + i] === segment);
    });
  }
}
