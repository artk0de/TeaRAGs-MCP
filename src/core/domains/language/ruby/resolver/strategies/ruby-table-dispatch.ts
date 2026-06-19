import type {
  CallContext,
  CallRef,
  DispatchEdge,
  DispatchRef,
  DispatchTable,
  DispatchTableDef,
  SymbolResolutionTarget,
} from "../../../../../contracts/types/codegraph.js";
import type { DispatchResolverComponent } from "../../../../../contracts/types/language.js";
import { isRubyPath, lastConstantSegment, resolveConstant, type ResolverConfig } from "./shared.js";

/**
 * Registry-literal dispatch fan-out (bd tea-rags-mcp-pq02v). A
 * `CONST[key].new.member` site whose `CONST` is a frozen hash/array of
 * value-classes (the walker tagged it with `CallRef.dispatch`) fans out to each
 * value class's `#member`. The candidate set is statically COMPLETE (every value
 * class is in the literal); a dynamic key fans to all (`registry`, `1/N`), a
 * static literal key narrows to one (`exact`, `1.0`).
 *
 * Implements `DispatchResolverComponent` (fan-out, per-edge confidence) — NOT the
 * single-target `SymbolResolutionStrategy` chain. Composed FIRST in
 * `RubyCallResolver.resolveDispatch` (most specific: concrete `CONST` + static
 * value set); returns `[]` for every non-dispatch call so cone/dynamic stay the
 * default. Never fabricates: an unresolvable table / class / method is dropped.
 */
export class RubyTableDispatchResolver implements DispatchResolverComponent {
  constructor(private readonly cfg: ResolverConfig) {}

  resolveDispatch(call: CallRef, ctx: CallContext): DispatchEdge[] {
    const ref = call.dispatch;
    if (!ref) return [];
    // The walker only tags a site once the dispatched member is known
    // (`CONST[k].new.member` → field set); a fieldless ref carries no method to
    // resolve against the value classes. Guard for type-safety + invariant.
    if (ref.field === null) return [];
    const def = this.selectTableDef(ref.table, ctx);
    if (!def) return [];

    const targets: SymbolResolutionTarget[] = [];
    const seen = new Set<string>();
    for (const className of candidateClasses(def.table, ref)) {
      const target = this.resolveClassMethod(className, ref.field, ctx);
      if (!target) continue;
      const key = `${target.targetRelPath}::${target.targetSymbolId ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push(target);
    }
    if (targets.length === 0) return [];

    const isStatic = ref.key !== null;
    const confidence = isStatic ? 1 : 1 / targets.length;
    return targets.map((t) => ({
      sourceSymbolId: null,
      targetRelPath: t.targetRelPath,
      targetSymbolId: t.targetSymbolId,
      edgeKind: isStatic ? "exact" : "registry",
      confidence,
    }));
  }

  /**
   * Pick the `DispatchTableDef` for a table name. Single global def → use.
   * Multiple → prefer the in-file declaration (a registry CONST is not in
   * fileScope nor Zeitwerk-autoloaded, so the table name cannot be import-
   * disambiguated); else drop rather than guess (m46z).
   */
  private selectTableDef(name: string, ctx: CallContext): DispatchTableDef | null {
    const defs = ctx.dispatchTables?.[name];
    if (!defs || defs.length === 0) return null;
    if (defs.length === 1) return defs[0];
    const inFile = defs.filter((d) => d.relPath === ctx.callerFile);
    return inFile.length === 1 ? inFile[0] : null;
  }

  /**
   * Resolve `Class#field` for a value-class FQ-name. The class FQ-name resolves
   * to its declaring file via `resolveConstant`; the method is then looked up by
   * exact `Class#field` fqName (filtered to that file) with a short-name
   * fallback scoped to the class's last segment. Ruby files only.
   */
  private resolveClassMethod(className: string, field: string, ctx: CallContext): SymbolResolutionTarget | null {
    const classRelPath = resolveConstant(className, ctx);
    if (classRelPath === null || !isRubyPath(classRelPath)) return null;

    const fq = `${className}#${field}`;
    const direct = ctx.symbolTable.lookup(fq).filter((d) => d.relPath === classRelPath);
    if (direct.length === 1) return { targetRelPath: direct[0].relPath, targetSymbolId: direct[0].symbolId };

    const shortSeg = lastConstantSegment(className);
    const byShort = ctx.symbolTable
      .lookupByShortName(field)
      .filter((d) => d.relPath === classRelPath && d.scope[d.scope.length - 1] === shortSeg);
    if (byShort.length === 1) return { targetRelPath: byShort[0].relPath, targetSymbolId: byShort[0].symbolId };

    return null;
  }
}

/**
 * Value-class FQ-names a `DispatchRef` selects from a Ruby registry table.
 * Static key → the one matching entry; dynamic key → every entry. Ruby registry
 * entries are always class-FQ-name strings (the `field` is the dispatched method
 * from the call site, NOT a sub-key of the entry — unlike the TS S1 wrapper map).
 */
function candidateClasses(table: DispatchTable, ref: DispatchRef): string[] {
  const keys = ref.key !== null ? [ref.key] : Object.keys(table.entries);
  const classes: string[] = [];
  for (const key of keys) {
    const entry = table.entries[key];
    if (typeof entry === "string") classes.push(entry);
  }
  return classes;
}
