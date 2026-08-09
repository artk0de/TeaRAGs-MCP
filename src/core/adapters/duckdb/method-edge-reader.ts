/**
 * Reads over `cg_symbols_edges_method` — the call graph as consumers see it:
 * callers, callees, batch adjacency for trace_path, the ambiguous-fan-out
 * aggregates, and the confidence-weighted chunk signals.
 *
 * Two things make this more than a set of SELECTs. First, `poly-base` edges are
 * stored capped (one edge to the base declaration) and re-expanded HERE through
 * the inheritance index, symmetrically in both directions — callers of an
 * override must include whoever reached it polymorphically, callees of a capped
 * edge must include the overriding subtypes. Second, fan-out edges carry a
 * confidence below 1, so counts are `SUM(confidence)` rather than `COUNT(*)`:
 * an m-way dispatch weighs one call site in total, not m.
 */

import type {
  AmbiguousCallerSite,
  CalleeEdge,
  CallerEdge,
  ChunkGraphSignals,
  MethodEdgeKind,
  RelPath,
  SymbolId,
} from "../../contracts/types/codegraph.js";
import type { DuckDbGraphSession } from "./graph-session.js";
import { splitMethodSymbol } from "./symbol-id-text.js";

export class DuckDbMethodEdgeReader {
  constructor(private readonly session: DuckDbGraphSession) {}

  async getCallers(symbolId: SymbolId): Promise<CallerEdge[]> {
    const direct = await this.session.queryAll<CallerEdge>(
      'SELECT source_symbol_id AS "sourceSymbolId", source_rel_path AS "sourceRelPath", call_expression AS "callExpression", edge_kind AS "edgeKind", confidence FROM cg_symbols_edges_method WHERE target_symbol_id = ? ORDER BY source_rel_path, source_symbol_id',
      [symbolId],
    );
    // bd tea-rags-mcp-2jet-E — symmetric CHA cone expansion. A large cone was
    // capped to ONE `poly-base` edge to the base declaration `T#m`. Callers of a
    // concrete override `Sub#m` must therefore ALSO include any caller that
    // (polymorphically) targeted `T#m` via poly-base, for every ancestor `T` of
    // `Sub`. Re-derive those callers through the forward inheritance index.
    const split = splitMethodSymbol(symbolId);
    if (!split) return direct;
    const polyBaseCallers = await this.session.queryAll<CallerEdge>(
      `SELECT m.source_symbol_id AS "sourceSymbolId", m.source_rel_path AS "sourceRelPath", m.call_expression AS "callExpression", m.edge_kind AS "edgeKind", m.confidence
         FROM cg_symbols_edges_method m
         JOIN cg_symbols_inheritance i ON i.source_fq_name = ?
        WHERE m.edge_kind = 'poly-base'
          AND m.target_symbol_id = i.ancestor_fq_name || ? || ?
        ORDER BY m.source_rel_path, m.source_symbol_id`,
      [split.base, split.sep, split.member],
    );
    if (polyBaseCallers.length === 0) return direct;
    return dedupeCallerEdges([...direct, ...polyBaseCallers]);
  }

  async getCallees(symbolId: SymbolId): Promise<CalleeEdge[]> {
    const edges = await this.session.queryAll<
      CalleeEdge & { edgeKind: MethodEdgeKind | null; confidence: number | null }
    >(
      `SELECT target_symbol_id AS "targetSymbolId", target_rel_path AS "targetRelPath", call_expression AS "callExpression", edge_kind AS "edgeKind", confidence
         FROM cg_symbols_edges_method WHERE source_symbol_id = ? ORDER BY target_rel_path`,
      [symbolId],
    );
    const out: CalleeEdge[] = [];
    for (const e of edges) {
      const base: CalleeEdge = {
        targetSymbolId: e.targetSymbolId,
        targetRelPath: e.targetRelPath,
        callExpression: e.callExpression,
        edgeKind: e.edgeKind ?? undefined,
        confidence: e.confidence ?? undefined,
      };
      out.push(base);
      // bd tea-rags-mcp-2jet-E — expand a `poly-base` edge to the overriding
      // subtypes at query time. The persisted edge points at the base decl
      // `T#m`; the reverse inheritance index yields the subtypes, and we keep
      // only those that actually DECLARE the override (an existing `Sub#m`
      // symbol). The base edge stays so a concrete base implementation is not
      // lost.
      if (e.edgeKind === "poly-base" && e.targetSymbolId) {
        out.push(...(await this.expandPolyBaseCallees(e.targetSymbolId, e.callExpression)));
      }
    }
    return out;
  }

  /**
   * Re-derive the overriding-subtype callee edges for a capped `poly-base` edge
   * (bd tea-rags-mcp-2jet-E). `baseTarget` is `T#m`; for each direct subtype `S`
   * of `T` that declares its own `S#m`, emit one callee edge. Subtypes that only
   * inherit `m` (no own declaration) are skipped — synthesizing `S#m` for them
   * would point at a symbol that does not exist.
   */
  private async expandPolyBaseCallees(baseTarget: SymbolId, callExpression: string): Promise<CalleeEdge[]> {
    const split = splitMethodSymbol(baseTarget);
    if (!split) return [];
    const rows = await this.session.queryAll<{ targetSymbolId: SymbolId; targetRelPath: RelPath }>(
      `SELECT s.symbol_id AS "targetSymbolId", s.rel_path AS "targetRelPath"
         FROM cg_symbols_inheritance i
         JOIN cg_symbols s ON s.symbol_id = i.source_fq_name || ? || ?
        WHERE i.ancestor_fq_name = ?
        ORDER BY s.symbol_id`,
      [split.sep, split.member, split.base],
    );
    return rows.map((r) => ({ targetSymbolId: r.targetSymbolId, targetRelPath: r.targetRelPath, callExpression }));
  }

  async getCalleeEdges(symbolIds: SymbolId[]): Promise<Map<SymbolId, SymbolId[]>> {
    const out = new Map<SymbolId, SymbolId[]>();
    if (symbolIds.length === 0) return out;
    const placeholders = symbolIds.map(() => "?").join(", ");
    const rows = await this.session.queryAll<{ source: SymbolId; target: SymbolId }>(
      // Navigation filter mirrors isNavigationVisibleEdge() in graph-facade.ts (xlnub Task 5):
      // dynamic edges with confidence < 1 are hidden from BFS traversal; all other
      // edge kinds (cone/exact/poly-base/registry) and legacy NULL-edgeKind edges are traversable.
      `SELECT source_symbol_id AS source, target_symbol_id AS target
       FROM cg_symbols_edges_method
       WHERE source_symbol_id IN (${placeholders}) AND target_symbol_id IS NOT NULL
         AND NOT (edge_kind = 'dynamic' AND COALESCE(confidence, 1) < 1)
       ORDER BY source_symbol_id, target_symbol_id`,
      symbolIds,
    );
    for (const { source, target } of rows) {
      const list = out.get(source);
      if (list) list.push(target);
      else out.set(source, [target]);
    }
    return out;
  }

  /**
   * Lazy ambiguous-group expansion read (bd tea-rags-mcp-f2jsb A4). Selects
   * the `cg_ambiguous_fanout` aggregates whose `member` equals the target's
   * member segment — uses the migration-013 member index. The suppressed
   * edges are NEVER materialized; consumers see the aggregate + its
   * candidateCount. `limit` is INLINED (not bound) for the same reason as
   * `getTransitiveImpact`'s depth: bindParams binds every value via
   * bindVarchar and a varchar LIMIT misbehaves — the value is sanitised to a
   * small positive integer first, so injection is structurally impossible.
   * Empty member short-circuits to [] (the kernel always records a non-empty
   * member, so nothing can match).
   */
  async getAmbiguousCallersByMember(member: string, limit = 50): Promise<AmbiguousCallerSite[]> {
    if (member.length === 0) return [];
    const safeLimit = Math.max(1, Math.floor(limit));
    const rows = await this.session.queryAll<{
      sourceSymbolId: string;
      sourceRelPath: string;
      callExpression: string;
      candidateCount: number | bigint;
    }>(
      `SELECT source_symbol_id AS "sourceSymbolId", source_rel_path AS "sourceRelPath",
              call_expression AS "callExpression", candidate_count AS "candidateCount"
         FROM cg_ambiguous_fanout WHERE member = ?
        ORDER BY source_symbol_id, call_expression
        LIMIT ${safeLimit}`,
      [member],
    );
    return rows.map((r) => ({
      sourceSymbolId: r.sourceSymbolId,
      sourceRelPath: r.sourceRelPath,
      callExpression: r.callExpression,
      candidateCount: Number(r.candidateCount),
    }));
  }

  /**
   * Confidence-weighted chunk fanIn (bd tea-rags-mcp-s5ato): SUM(confidence)
   * over incoming method edges instead of COUNT(*). A dynamic/cone dispatch
   * site that fans out to m candidates at confidence 1/m contributes ~1 call
   * site in total — COUNT(*) previously inflated every fan-out target into a
   * fake hub (m× per fan). Exact edges and legacy NULL-confidence rows weigh
   * 1.0, so purely-exact graphs keep integer counts. The result is a FLOAT,
   * rounded to 2 decimals at this boundary (see `roundEdgeWeightSum`).
   */
  async getCalledByCount(symbolId: SymbolId): Promise<number> {
    const rows = await this.session.queryAll<{ n: number | null }>(
      "SELECT SUM(COALESCE(confidence, 1.0)) AS n FROM cg_symbols_edges_method WHERE target_symbol_id = ?",
      [symbolId],
    );
    return roundEdgeWeightSum(Number(rows[0]?.n ?? 0));
  }

  /**
   * Confidence-weighted chunk fanOut — counterpart of `getCalledByCount`:
   * SUM(confidence) over outgoing method edges, so a whole m-way fan-out
   * (m edges at 1/m) counts as ONE outgoing call. Same NULL→1.0 legacy
   * coalesce and 2-decimal boundary rounding.
   */
  async getCallSiteCount(symbolId: SymbolId): Promise<number> {
    const rows = await this.session.queryAll<{ n: number | null }>(
      "SELECT SUM(COALESCE(confidence, 1.0)) AS n FROM cg_symbols_edges_method WHERE source_symbol_id = ?",
      [symbolId],
    );
    return roundEdgeWeightSum(Number(rows[0]?.n ?? 0));
  }

  /**
   * Set-based read-back of `{ fanIn, fanOut, pageRank }` for every symbol in the
   * graph — the batched replacement for looping `getCalledByCount` +
   * `getCallSiteCount` + `getPageRank` per chunk (`buildChunkSignals`). Three
   * whole-table GROUP-BY / scan queries (no `IN (…)` list → no param-limit
   * chunking) instead of `3 × chunkCount` point queries. Each value is computed
   * identically to the per-symbol getter — same `SUM(COALESCE(confidence, 1.0))`
   * with `roundEdgeWeightSum`, same `Number()` pageRank — so a caller that reads
   * `map.get(id) ?? { 0, 0, 0 }` gets byte-identical results.
   */
  async getChunkSignalsBulk(): Promise<Map<SymbolId, ChunkGraphSignals>> {
    const out = new Map<SymbolId, ChunkGraphSignals>();
    const entryFor = (id: string): ChunkGraphSignals => {
      let e = out.get(id);
      if (!e) {
        e = { fanIn: 0, fanOut: 0, pageRank: 0 };
        out.set(id, e);
      }
      return e;
    };
    const fanInRows = await this.session.queryAll<{ id: string; n: number | null }>(
      "SELECT target_symbol_id AS id, SUM(COALESCE(confidence, 1.0)) AS n FROM cg_symbols_edges_method GROUP BY target_symbol_id",
    );
    for (const r of fanInRows) entryFor(r.id).fanIn = roundEdgeWeightSum(Number(r.n ?? 0));
    const fanOutRows = await this.session.queryAll<{ id: string; n: number | null }>(
      "SELECT source_symbol_id AS id, SUM(COALESCE(confidence, 1.0)) AS n FROM cg_symbols_edges_method GROUP BY source_symbol_id",
    );
    for (const r of fanOutRows) entryFor(r.id).fanOut = roundEdgeWeightSum(Number(r.n ?? 0));
    const pageRankRows = await this.session.queryAll<{ id: string; page_rank: number | bigint | string }>(
      "SELECT symbol_id AS id, page_rank FROM cg_symbols_metrics",
    );
    for (const r of pageRankRows) entryFor(r.id).pageRank = Number(r.page_rank);
    return out;
  }
}

/**
 * Dedupe caller edges by `(sourceSymbolId, callExpression)` (bd 2jet-E). The
 * symmetric poly-base expansion can re-surface a caller the direct query already
 * returned (e.g. a class that both directly calls the override AND reaches it
 * polymorphically). First occurrence wins; ordering of the merged list is
 * preserved.
 */
function dedupeCallerEdges(edges: CallerEdge[]): CallerEdge[] {
  const seen = new Set<string>();
  const out: CallerEdge[] = [];
  for (const e of edges) {
    const k = `${e.sourceSymbolId} ${e.callExpression}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}

/**
 * Boundary rounding for confidence-weighted edge sums (bd tea-rags-mcp-s5ato).
 * The `confidence` column is REAL (float32) and SUM accumulates in DOUBLE, so
 * three 1/3-confidence edges yield 1.0000000298… — round to 2 decimals so
 * float noise never leaks into Qdrant payloads while fractional weights
 * (e.g. fanIn 1.25) survive intact. Deliberately NOT Math.round to integer:
 * consumers (chunk fanIn/fanOut payload signals, derived-signal normalization,
 * range filters) all tolerate non-integers, and the fraction IS the signal.
 */
function roundEdgeWeightSum(sum: number): number {
  return Math.round(sum * 100) / 100;
}
