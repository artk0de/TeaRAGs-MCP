import type {
  CallContext,
  CallRef,
  DispatchEdge,
  DispatchFanoutOutcome,
  DispatchRef,
  DispatchTableDef,
  DispatchTableEntry,
  SymbolResolutionTarget,
} from "../../../contracts/types/codegraph.js";
import type { DispatchResolverComponent } from "../../../contracts/types/language.js";

/**
 * The two language-specific operations of lookup-table dispatch. The kernel
 * owns key narrowing, dedup, ordering and the edge-kind / confidence rule; the
 * language owns which table a name means and what an entry value points at.
 */
export interface TableDispatchPorts {
  /**
   * The table a `DispatchRef` means from the caller's point of view, or `null`
   * to drop the site (unknown, ambiguous, or a ref shape the language does not
   * dispatch). Never a namesake guess (m46z).
   */
  selectTableDef: (ref: DispatchRef, ctx: CallContext) => DispatchTableDef | null;
  /**
   * The symbol one selected entry value reaches, read in the shape `ref` asks
   * for (`field`, `viaInstance`) from the table's declaring file `def.relPath`;
   * `null` drops that entry — the rest still fan.
   */
  resolveEntry: (
    dispatchTableEntry: DispatchTableEntry,
    ref: DispatchRef,
    def: DispatchTableDef,
    call: CallRef,
    ctx: CallContext,
  ) => SymbolResolutionTarget | null;
}

/**
 * Language-neutral lookup-table dispatch fan-out (bd tea-rags-mcp-pq02v Ruby
 * registry, bd tea-rags-mcp-pbwd Python dict tables). A call through a const
 * table (`CONST[key]…`) whose candidate set is statically COMPLETE — every
 * value is in the literal — fans out to the entries the key selects:
 *
 *   - a static literal key narrows to ONE entry → `exact` edge at `1.0`;
 *   - a dynamic key fans to EVERY entry → `registry` edges sharing unit
 *     confidence `1/N` over the N entries that resolved (an unresolvable entry
 *     is dropped, not counted).
 *
 * Targets are deduplicated by `relPath::symbolId` in table insertion order.
 * Implements `DispatchResolverComponent` (fan-out, per-edge confidence) and
 * returns an empty outcome for every call without a dispatch reference, so it
 * composes first in a dispatch cascade without shadowing the cone.
 */
export class TableDispatchResolver implements DispatchResolverComponent {
  constructor(private readonly ports: TableDispatchPorts) {}

  resolveDispatch(call: CallRef, ctx: CallContext): DispatchFanoutOutcome {
    return { kind: "edges", edges: call.dispatch ? this.fanOut(call.dispatch, null, call, ctx) : [] };
  }

  /**
   * Fan one `DispatchRef` out to its entries. `sourceSymbolId: null` sources
   * the edges at the calling chunk; a non-null id sources them at that symbol
   * (a callee invoking a passed-in table value — `DispatchEdge.sourceSymbolId`).
   */
  fanOut(ref: DispatchRef, sourceSymbolId: string | null, call: CallRef, ctx: CallContext): DispatchEdge[] {
    const def = this.ports.selectTableDef(ref, ctx);
    if (!def) return [];

    const targets: SymbolResolutionTarget[] = [];
    const seen = new Set<string>();
    const keys = ref.key !== null ? [ref.key] : Object.keys(def.table.entries);
    for (const key of keys) {
      const dispatchTableEntry = def.table.entries[key];
      if (dispatchTableEntry === undefined) continue;
      const target = this.ports.resolveEntry(dispatchTableEntry, ref, def, call, ctx);
      if (!target) continue;
      const dedupKey = `${target.targetRelPath}::${target.targetSymbolId ?? ""}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);
      targets.push(target);
    }
    if (targets.length === 0) return [];

    const isStatic = ref.key !== null;
    const confidence = isStatic ? 1 : 1 / targets.length;
    return targets.map((t) => ({
      sourceSymbolId,
      targetRelPath: t.targetRelPath,
      targetSymbolId: t.targetSymbolId,
      edgeKind: isStatic ? "exact" : "registry",
      confidence,
    }));
  }
}
