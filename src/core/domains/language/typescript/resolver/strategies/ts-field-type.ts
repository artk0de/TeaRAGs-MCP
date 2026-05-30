import { CONTINUE, resolved } from "../../../../../contracts/resolution.js";
import { pickSingleCandidate, type CallContext, type CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import type { ResolverConfig } from "./shared.js";

/**
 * Cross-class via field access — `this.<field>.<method>()`. Look up the field's
 * declared type in `classFieldTypes` and resolve the method against that type
 * in the global symbol table. Tries the `#` (instance) form first, then falls
 * back to `.` (static). Only one level of access is supported —
 * `this.foo.bar.baz()` (chained) would need recursive type inference, out of
 * scope. On miss, continue.
 */
export class TSFieldTypeSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "fieldType";
  constructor(private readonly cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (!call.receiver || !call.receiver.startsWith("this.") || ctx.callerScope.length === 0) return CONTINUE;
    const fieldSegment = call.receiver.slice("this.".length);
    if (fieldSegment.includes(".")) return CONTINUE;

    const enclosing = ctx.callerScope[ctx.callerScope.length - 1];
    const typeName = ctx.classFieldTypes?.[enclosing]?.[fieldSegment];
    if (!typeName) return CONTINUE;

    // Instance form first — most common dispatch shape. Strict mode drops the
    // edge when more than one type shares the method name across files; legacy
    // `first` mode keeps the first hit.
    const instanceCandidates = ctx.symbolTable.lookup(`${typeName}#${call.member}`);
    const instanceHit = pickSingleCandidate(instanceCandidates, this.cfg.mode);
    if (instanceHit) return resolved({ targetRelPath: instanceHit.relPath, targetSymbolId: instanceHit.symbolId });

    // Static fallback — `this.helper.staticMethod()` shape.
    const staticCandidates = ctx.symbolTable.lookup(`${typeName}.${call.member}`);
    const staticHit = pickSingleCandidate(staticCandidates, this.cfg.mode);
    if (staticHit) return resolved({ targetRelPath: staticHit.relPath, targetSymbolId: staticHit.symbolId });

    return CONTINUE;
  }
}
