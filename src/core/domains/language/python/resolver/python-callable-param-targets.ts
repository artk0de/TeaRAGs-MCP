import type {
  CallableArgSource,
  CallContext,
  CallRef,
  RelPath,
  SymbolDefinition,
} from "../../../../contracts/types/codegraph.js";
import { RunScopedMemo } from "../../kernel/run-scoped-memo.js";
import type { PythonImportFileMapper } from "./python-import-file-mapper.js";
import { resolvePythonModuleScopeSpelling } from "./python-module-scope-spelling.js";

/** One passing site, with the file it was recorded in. */
interface CallableArgSourceEntry {
  readonly relPath: RelPath;
  readonly source: CallableArgSource;
}

/**
 * The functions a parameter call can invoke (P2 callable-value flow, bd
 * tea-rags-mcp-m99j1.1.19): the call carries `calleeParam` — which
 * module-level def owns the parameter, at which call-site position — and
 * `callableArgSources` holds every site, in any file, that passes a function
 * reference into a callee of that short name. Read by both halves of the
 * mechanism: `PythonCallableParamSymbolResolutionStrategy` (one target) and
 * `PythonCallableParamDispatchResolver` (several).
 *
 * A site counts only when its OWN file's module scope binds the callee to the
 * owner — the def in the caller's file, reached through that file's
 * declarations or `from` imports (`resolvePythonModuleScopeSpelling`) — so a
 * namesake decorator elsewhere feeds nothing. Its argument is read from the
 * same scope, and must land on a def that is not a class: a class passed in is
 * instantiated, not called.
 *
 * The set is a LOWER bound (a callable passed through a local, a lambda or a
 * keyword is not recorded), which is why one source is an `exact` answer — it
 * is a target the call really reaches — and several are `cone` candidates
 * sharing unit confidence.
 */
export class PythonCallableParamTargets {
  private readonly bySite = new WeakMap<CallRef, { ctx: CallContext; targets: readonly SymbolDefinition[] }>();
  private readonly byMember = new RunScopedMemo<object, ReadonlyMap<string, readonly CallableArgSourceEntry[]>>();

  constructor(private readonly mapper: PythonImportFileMapper) {}

  targetsOf(call: CallRef, ctx: CallContext): readonly SymbolDefinition[] {
    if (call.calleeParam === undefined || ctx.callableArgSources === undefined) return [];
    // A binding the walker recorded for the name — a typed parameter, say — is
    // `localBinding`'s evidence and outranks the passed-in set, on both halves.
    if (ctx.localBindings !== undefined && Object.prototype.hasOwnProperty.call(ctx.localBindings, call.member)) {
      return [];
    }
    const hit = this.bySite.get(call);
    if (hit?.ctx === ctx) return hit.targets;
    const targets = this.compute(call.calleeParam, ctx);
    this.bySite.set(call, { ctx, targets });
    return targets;
  }

  private compute(param: NonNullable<CallRef["calleeParam"]>, ctx: CallContext): readonly SymbolDefinition[] {
    const sites = this.sitesByMember(ctx).get(param.ownerSymbolId) ?? [];
    const out: SymbolDefinition[] = [];
    for (const { relPath, source } of sites) {
      if (source.argIndex !== param.position) continue;
      const callee =
        source.calleeReceiver === null ? param.ownerSymbolId : `${source.calleeReceiver}.${param.ownerSymbolId}`;
      const owner = resolvePythonModuleScopeSpelling(callee, relPath, ctx, this.mapper);
      if (owner?.targetSymbolId !== param.ownerSymbolId || owner.targetRelPath !== ctx.callerFile) continue;
      const passed = resolvePythonModuleScopeSpelling(source.argument, relPath, ctx, this.mapper);
      const def = passed?.targetSymbolId ? definitionOf(passed.targetSymbolId, passed.targetRelPath, ctx) : undefined;
      if (def === undefined || def.symbolKind === "class") continue;
      if (!out.some((d) => d.symbolId === def.symbolId && d.relPath === def.relPath)) out.push(def);
    }
    return out;
  }

  /**
   * `callableArgSources` re-keyed by callee member — built once per run and record.
   * Keyed under `ctx.runScope`: the run-global record is mutated in place across
   * passes, so its identity alone is not the run (bd tea-rags-mcp-39xca.6).
   */
  private sitesByMember(ctx: CallContext): ReadonlyMap<string, readonly CallableArgSourceEntry[]> {
    const record = ctx.callableArgSources ?? {};
    const cached = this.byMember.get(ctx.runScope, record);
    if (cached) return cached;
    const index = new Map<string, CallableArgSourceEntry[]>();
    for (const [key, sources] of Object.entries(record)) {
      const split = key.lastIndexOf("::");
      if (split === -1) continue;
      const relPath = key.slice(0, split);
      const member = key.slice(split + 2);
      let list = index.get(member);
      if (!list) index.set(member, (list = []));
      for (const source of sources) list.push({ relPath, source });
    }
    this.byMember.set(ctx.runScope, record, index);
    return index;
  }
}

function definitionOf(symbolId: string, relPath: RelPath, ctx: CallContext): SymbolDefinition | undefined {
  const shortName = symbolId.split(/[#.]/).pop() ?? symbolId;
  return ctx.symbolTable
    .lookupByShortName(shortName)
    .find((def) => def.symbolId === symbolId && def.relPath === relPath);
}
