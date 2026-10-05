import { identifierEntry } from "../../../../../contracts/identifier-record.js";
import type {
  CallContext,
  CallRef,
  DispatchRef,
  DispatchTableDef,
  DispatchTableEntry,
  SymbolResolutionTarget,
} from "../../../../../contracts/types/codegraph.js";
import { TableDispatchResolver, type TableDispatchPorts } from "../../../kernel/index.js";
import {
  isRubyPath,
  lastConstantSegment,
  lookupRubySymbolsByShortName,
  resolveConstant,
  symbolIdIsClassMethod,
  symbolIdIsInstanceMethod,
  type ResolverConfig,
} from "./shared.js";

/**
 * Registry-literal dispatch fan-out (bd tea-rags-mcp-pq02v). A
 * `CONST[key].new.member` site whose `CONST` is a frozen hash/array of
 * value-classes (the walker tagged it with `CallRef.dispatch`) fans out to each
 * value class's member — `#member` after an instantiator hop, `.member` for a
 * direct class-method call (`DispatchRef.viaInstance`, bd tea-rags-mcp-exmwr).
 * The candidate set is statically COMPLETE (every value class is in the
 * literal); key narrowing, dedup and the `exact` (`1.0`) / `registry` (`1/N`)
 * rule are the kernel's `TableDispatchResolver` — this class supplies the Ruby
 * ports (`RUBY_TABLE_DISPATCH_PORTS`).
 *
 * Composed FIRST in `RubyCallResolver.resolveDispatch` (most specific: concrete
 * `CONST` + static value set); returns `[]` for every non-dispatch call so
 * cone/dynamic stay the default. Never fabricates: an unresolvable table /
 * class / method is dropped.
 */
export class RubyTableDispatchResolver extends TableDispatchResolver {
  /** `cfg` is the uniform Ruby strategy constructor shape; the ports read none of it. */
  constructor(_cfg: ResolverConfig) {
    super(RUBY_TABLE_DISPATCH_PORTS);
  }
}

/**
 * Pick the `DispatchTableDef` for a ref's table name. The walker only tags a
 * site once the dispatched member is known (`CONST[k].new.member` → field
 * set); a fieldless ref carries no method to resolve against the value
 * classes, so it selects nothing. Single global def → use. Multiple → prefer
 * the in-file declaration (a registry CONST is not in fileScope nor
 * Zeitwerk-autoloaded, so the table name cannot be import-disambiguated); else
 * drop rather than guess (m46z).
 */
function selectRubyTableDef(ref: DispatchRef, ctx: CallContext): DispatchTableDef | null {
  if (ref.field === null) return null;
  const defs = identifierEntry(ctx.dispatchTables, ref.table);
  if (!defs || defs.length === 0) return null;
  if (defs.length === 1) return defs[0];
  const inFile = defs.filter((d) => d.relPath === ctx.callerFile);
  return inFile.length === 1 ? inFile[0] : null;
}

/**
 * Ruby registry entries are always class-FQ-name strings: the `field` is the
 * dispatched method from the call site, NOT a sub-key of the entry (unlike the
 * S1 wrapper map), so an object entry contributes nothing.
 */
function resolveRubyTableEntry(
  dispatchTableEntry: DispatchTableEntry,
  ref: DispatchRef,
  _def: DispatchTableDef,
  _call: CallRef,
  ctx: CallContext,
): SymbolResolutionTarget | null {
  if (typeof dispatchTableEntry !== "string" || ref.field === null) return null;
  return resolveMember(dispatchTableEntry, ref.field, ref.viaInstance === true, ctx);
}

const RUBY_TABLE_DISPATCH_PORTS: TableDispatchPorts = {
  selectTableDef: selectRubyTableDef,
  resolveEntry: resolveRubyTableEntry,
};

/**
 * Resolve a member of a value-class FQ-name in the form the CALL SHAPE asks
 * for: `Class#field` when the chain instantiated (`CONST[k].new.field`),
 * `Class.field` for a direct class-method call (`CONST[k].field`) — bd
 * tea-rags-mcp-exmwr. The class FQ-name resolves to its declaring file via
 * `resolveConstant`; the member is then looked up by exact fqName (filtered to
 * that file) with a short-name fallback scoped to the class's last segment.
 * Both paths reject the OTHER form, so a class call never lands on an instance
 * def (and vice versa) — dropping is correct: the real target is then an
 * inherited framework method with no in-project `def`. Ruby files only.
 */
function resolveMember(
  className: string,
  field: string,
  viaInstance: boolean,
  ctx: CallContext,
): SymbolResolutionTarget | null {
  const classRelPath = resolveConstant(className, ctx);
  if (classRelPath === null || !isRubyPath(classRelPath)) return null;

  const formMatches = viaInstance ? symbolIdIsInstanceMethod : symbolIdIsClassMethod;
  const fq = `${className}${viaInstance ? "#" : "."}${field}`;
  const direct = ctx.symbolTable.lookup(fq).filter((d) => d.relPath === classRelPath);
  if (direct.length === 1) return { targetRelPath: direct[0].relPath, targetSymbolId: direct[0].symbolId };

  const shortSeg = lastConstantSegment(className);
  const byShort = lookupRubySymbolsByShortName(ctx, field, { role: "callee" }).filter(
    (d) => d.relPath === classRelPath && d.scope[d.scope.length - 1] === shortSeg && formMatches(d.symbolId, field),
  );
  if (byShort.length === 1) return { targetRelPath: byShort[0].relPath, targetSymbolId: byShort[0].symbolId };

  return null;
}
