import { identifierEntry } from "../../../../../contracts/identifier-record.js";
import type {
  CallContext,
  CallRef,
  DispatchEdge,
  DispatchFanoutOutcome,
  DispatchRef,
  DispatchTableDef,
  DispatchTableEntry,
  RelPath,
  SymbolResolutionTarget,
} from "../../../../../contracts/types/codegraph.js";
import { TableDispatchResolver, type TableDispatchPorts } from "../../../kernel/index.js";
import type { PythonImportFileMapper } from "../python-import-file-mapper.js";
import { lookupPythonSymbolsByShortName, pythonImportBoundFile } from "../strategies/shared.js";

/** The production chain's answer for one call — `PythonChainAnswerProbe#resolve`. */
export type PythonCallAnswer = (call: CallRef, ctx: CallContext) => SymbolResolutionTarget | null;

/**
 * Dict-table dispatch fan-out (bd tea-rags-mcp-pbwd, epic 542x) — the Python
 * resolver half of the lookup-table mechanism the TypeScript resolver ships (bd
 * tea-rags-mcp-n0zj), with Ruby's edge vocabulary (bd tea-rags-mcp-pq02v): a
 * static string key narrows to ONE `exact` edge at 1.0, a dynamic key fans to
 * every entry as `registry` edges sharing unit confidence (`1/N`). Key
 * narrowing, dedup and that rule are the kernel's `TableDispatchResolver`; this
 * class supplies the Python ports (`PythonTableDispatchPorts`).
 *
 * Two channels, both from `CallRef`:
 *   - `dispatch` — fan from the CALLER to each callable the table selects
 *     (the kernel's own channel);
 *   - `dispatchArgs` — the bounded single-hop join: resolve the ordinary callee
 *     `F` through the production chain, and when a candidate set lands on one of
 *     `F`'s `callbackParams` positions fan from `F` instead.
 *
 * Composed FIRST in `PythonCallResolver.resolveDispatch`: it is the most
 * specific component (a concrete table with a static value set) and returns
 * nothing for every call without a dispatch channel, so the cone and the parked
 * `dynamic` component keep their order behind it.
 *
 * Never fabricates — see `PythonTableDispatchPorts` for how the table and each
 * entry are chosen.
 */
export class PythonTableDispatchResolver extends TableDispatchResolver {
  constructor(
    private readonly answer: PythonCallAnswer,
    mapper: PythonImportFileMapper,
  ) {
    super(new PythonTableDispatchPorts(answer, mapper));
  }

  override resolveDispatch(call: CallRef, ctx: CallContext): DispatchFanoutOutcome {
    if (call.dispatch) return super.resolveDispatch(call, ctx);
    if (!call.dispatchArgs || call.dispatchArgs.length === 0) return { kind: "edges", edges: [] };
    const callee = this.answer(call, ctx)?.targetSymbolId ?? null;
    const invoked = callee === null ? undefined : identifierEntry(ctx.callbackParams, callee);
    if (callee === null || !invoked || invoked.length === 0) return { kind: "edges", edges: [] };
    const edges: DispatchEdge[] = [];
    for (const arg of call.dispatchArgs) {
      if (invoked.includes(arg.argIndex)) edges.push(...this.fanOut(arg.candidate, callee, call, ctx));
    }
    return { kind: "edges", edges };
  }
}

/**
 * The Python reading of a dict table. The table is chosen through the
 * CALLER's own evidence — its import binding for the name, or its own file —
 * never by a namesake guess; an entry that does not resolve is dropped, and
 * the rest still fan.
 *
 * An entry resolves the way a DIRECT call spelled the same way would:
 *   - in a table the caller's own file declares, the entry goes through the
 *     production chain as a module-scope call (`on_a` → `on_a()`,
 *     `Handlers.on_a` → `Handlers.on_a()`), so the chain's import, LEGB and
 *     class-member rules decide it and the table cannot disagree with a
 *     hand-written call;
 *   - in an IMPORTED table the caller's imports say nothing about the table
 *     file's names, so the entry is looked up from that file: declared there at
 *     module level, or one re-export walk on (`resolveExportedName` over the
 *     table file's own `from` statements). A dotted entry resolves as
 *     `Class.member` of a class reached that way, or as `module.fn` when the
 *     table file bound `module` by a `from` import (`resolveExportedModule` —
 *     ugnest's `SCENARIOS = {"active": active.seed}` registry). A longer
 *     dotted spelling, or a head bound by a plain `import`, drops.
 */
class PythonTableDispatchPorts implements TableDispatchPorts {
  constructor(
    private readonly answer: PythonCallAnswer,
    private readonly mapper: PythonImportFileMapper,
  ) {}

  /**
   * The table the CALLER means: the file its import binding for the name
   * reaches (one re-export hop on), or its own file when it binds nothing and
   * declares the table. Anything else — a namesake declared elsewhere with no
   * binding in sight — is dropped rather than guessed (m46z).
   */
  selectTableDef = (ref: DispatchRef, ctx: CallContext): DispatchTableDef | null => {
    const defs = identifierEntry(ctx.dispatchTables, ref.table);
    if (!defs || defs.length === 0) return null;
    const file = pythonImportBoundFile(
      ref.table,
      defs.map((d) => d.relPath),
      ctx,
      this.mapper,
    );
    const picked = file === null ? [] : defs.filter((d) => d.relPath === file);
    return picked.length === 1 ? picked[0] : null;
  };

  /**
   * S2 (`field === null`) reads the entry itself, S1 reads `entry[field]`; a
   * wrong-shape entry contributes nothing.
   */
  resolveEntry = (
    dispatchTableEntry: DispatchTableEntry,
    ref: DispatchRef,
    def: DispatchTableDef,
    call: CallRef,
    ctx: CallContext,
  ): SymbolResolutionTarget | null => {
    const spelling = entrySpelling(dispatchTableEntry, ref);
    return spelling === null ? null : this.resolveSpelling(spelling, def.relPath, call, ctx);
  };

  private resolveSpelling(
    spelling: string,
    tableFile: RelPath,
    call: CallRef,
    ctx: CallContext,
  ): SymbolResolutionTarget | null {
    const dot = spelling.lastIndexOf(".");
    const receiver = dot === -1 ? null : spelling.slice(0, dot);
    const member = dot === -1 ? spelling : spelling.slice(dot + 1);
    if (tableFile === ctx.callerFile) {
      const entryCall: CallRef = { callText: `${spelling}()`, receiver, member, startLine: call.startLine };
      return this.answer(entryCall, moduleScopeContext(ctx));
    }
    if (receiver === null) return this.declaredAtModuleLevel(member, tableFile, ctx);
    if (receiver.includes(".")) return null;
    const cls = this.declaredAtModuleLevel(receiver, tableFile, ctx);
    if (cls) {
      const members = lookupPythonSymbolsByShortName(ctx, member, { role: "callee" }).filter(
        (d) => d.relPath === cls.targetRelPath && d.scope.length === 1 && d.scope[0] === receiver,
      );
      return members.length === 1 ? { targetRelPath: members[0].relPath, targetSymbolId: members[0].symbolId } : null;
    }
    // `module.fn` — the head is a module the table file imported by name.
    const moduleFile = this.mapper.resolveExportedModule(tableFile, receiver, ctx);
    return moduleFile === null ? null : this.declaredAtModuleLevel(member, moduleFile, ctx);
  }

  /** `name` as the table file sees it: declared there, or re-exported into it. */
  private declaredAtModuleLevel(name: string, tableFile: RelPath, ctx: CallContext): SymbolResolutionTarget | null {
    const file = this.mapper.resolveExportedName(tableFile, name, ctx) ?? tableFile;
    const defs = lookupPythonSymbolsByShortName(ctx, name).filter((d) => d.relPath === file && d.scope.length === 0);
    return defs.length === 1 ? { targetRelPath: defs[0].relPath, targetSymbolId: defs[0].symbolId } : null;
  }
}

/**
 * The caller's context moved to module scope: a table's values are read where
 * the table is declared, so the call site's enclosing frames and locals must
 * not shadow them.
 */
function moduleScopeContext(ctx: CallContext): CallContext {
  return {
    ...ctx,
    callerScope: [],
    callerSymbolId: undefined,
    localBindings: undefined,
    callResultBindings: undefined,
  };
}

/** The callable spelling one entry carries for `ref`: the entry (S2) or its `field` (S1). */
function entrySpelling(dispatchTableEntry: DispatchTableEntry, ref: DispatchRef): string | null {
  if (ref.field === null) return typeof dispatchTableEntry === "string" ? dispatchTableEntry : null;
  if (typeof dispatchTableEntry !== "object") return null;
  const callable = dispatchTableEntry[ref.field];
  return typeof callable === "string" ? callable : null;
}
