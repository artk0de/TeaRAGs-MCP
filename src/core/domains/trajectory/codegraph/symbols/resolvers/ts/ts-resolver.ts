/**
 * TypeScript implementation of the `CallResolver` contract.
 *
 * Resolution strategy:
 *   1. `this.X()` / `super.X()` — look up `<enclosingClass>.X` in the
 *      caller's own file, where `enclosingClass` is the first segment of
 *      `ctx.callerScope`. This captures intra-class calls that would
 *      otherwise be dropped (`this` has no entry in `ctx.imports`).
 *   2. If the call has a receiver, look it up in `ctx.imports`. If matched,
 *      `mapImportToFile` resolves the path; then `lookupByShortName(member)`
 *      restricted to that target file gives the symbolId.
 *   3. Fall back to a global `lookupByShortName(member)` — handles default
 *      exports, ambient declarations, and free calls.
 *   4. If none resolves, return `null` (orphan calls are dropped by the
 *      provider; recording an edge with `targetSymbolId: null` only when the
 *      target file is known).
 */

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  pickSingleCandidate,
  type AmbiguousResolveMode,
  type CallContext,
  type CallRef,
  type CallResolver,
  type ResolvedTarget,
} from "../../../../../../contracts/types/codegraph.js";
import { mapImportToFile, type TsCompilerOptions } from "./ts-path-mapper.js";

export class TSCallResolver implements CallResolver {
  readonly language = "typescript";

  constructor(
    private readonly tsOptions: TsCompilerOptions,
    private readonly mode: AmbiguousResolveMode = DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  ) {}

  resolve(call: CallRef, ctx: CallContext): ResolvedTarget | null {
    // Intra-class `this.X()` / `super.X()`. Both forms invoke an
    // INSTANCE method by definition, so the target symbolId is
    // composed as `<EnclosingClass>#<member>` per the project
    // convention (`.claude/rules/symbolid-convention.md`).
    // `callerScope` carries the enclosing class chain — last element
    // is the immediate class. Lookup is exact and constrained to the
    // caller's own file so a same-shortName method elsewhere can't
    // misroute.
    if (call.receiver === "this" || call.receiver === "super") {
      if (ctx.callerScope.length > 0) {
        const enclosing = ctx.callerScope[ctx.callerScope.length - 1];
        const fqName = `${enclosing}#${call.member}`;
        const direct = ctx.symbolTable.lookup(fqName).find((def) => def.relPath === ctx.callerFile);
        if (direct) return { targetRelPath: direct.relPath, targetSymbolId: direct.symbolId };
        // Static dispatch within the class — `this.staticHelper` is
        // unusual but legal; the target symbolId then uses `.`.
        const staticFqName = `${enclosing}.${call.member}`;
        const staticHit = ctx.symbolTable.lookup(staticFqName).find((def) => def.relPath === ctx.callerFile);
        if (staticHit) return { targetRelPath: staticHit.relPath, targetSymbolId: staticHit.symbolId };
        // Class instance shadowed via getter / decorator / mixin: fall
        // back to short-name lookup within the same file, which still
        // beats global ambiguity.
        const sameFile = ctx.symbolTable.lookupByShortName(call.member).find((def) => def.relPath === ctx.callerFile);
        if (sameFile) return { targetRelPath: sameFile.relPath, targetSymbolId: sameFile.symbolId };
      }
    }
    // Cross-class via field access — `this.<field>.<method>()`. Look up
    // the field's declared type in `classFieldTypes` and resolve the
    // method against that type in the global symbol table. Tries the
    // `#` (instance) form first, then falls back to `.` (static).
    if (call.receiver && call.receiver.startsWith("this.") && ctx.callerScope.length > 0) {
      const fieldSegment = call.receiver.slice("this.".length);
      // Only one level of access supported — `this.foo.bar()` resolves.
      // `this.foo.bar.baz()` (chained) would need recursive type inference,
      // out of scope for slice 1.
      if (!fieldSegment.includes(".")) {
        const enclosing = ctx.callerScope[ctx.callerScope.length - 1];
        const typeName = ctx.classFieldTypes?.[enclosing]?.[fieldSegment];
        if (typeName) {
          // Instance form first — most common dispatch shape. Strict
          // mode drops the edge when more than one type shares the
          // method name across files; legacy `first` mode keeps the
          // first hit.
          const instanceCandidates = ctx.symbolTable.lookup(`${typeName}#${call.member}`);
          const instanceHit = pickSingleCandidate(instanceCandidates, this.mode);
          if (instanceHit) {
            return { targetRelPath: instanceHit.relPath, targetSymbolId: instanceHit.symbolId };
          }
          // Static fallback — `this.helper.staticMethod()` shape.
          const staticCandidates = ctx.symbolTable.lookup(`${typeName}.${call.member}`);
          const staticHit = pickSingleCandidate(staticCandidates, this.mode);
          if (staticHit) {
            return { targetRelPath: staticHit.relPath, targetSymbolId: staticHit.symbolId };
          }
        }
      }
    }
    if (call.receiver) {
      const match = ctx.imports.find((imp) => importMatchesReceiver(imp.importText, call.receiver as string));
      if (match) {
        const targetFile = mapImportToFile(match.importText, ctx.callerFile, this.tsOptions);
        if (targetFile) {
          const candidates = ctx.symbolTable.lookupByShortName(call.member).filter((def) => def.relPath === targetFile);
          const target = pickSingleCandidate(candidates, this.mode);
          if (target) return { targetRelPath: target.relPath, targetSymbolId: target.symbolId };
          return { targetRelPath: targetFile, targetSymbolId: null };
        }
      }
    }
    const fallback = ctx.symbolTable.lookupByShortName(call.member);
    const fallbackHit = pickSingleCandidate(fallback, this.mode);
    if (fallbackHit) return { targetRelPath: fallbackHit.relPath, targetSymbolId: fallbackHit.symbolId };
    return null;
  }
}

function importMatchesReceiver(importText: string, receiver: string): boolean {
  const segments = importText.split("/");
  const last = segments[segments.length - 1] ?? "";
  return last.toLowerCase() === receiver.toLowerCase();
}
